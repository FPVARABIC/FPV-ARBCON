import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  analyzeOrientationStability,
  ORIENTATION_STABILITY_WINDOW_MS,
} from '../../../core';
import type {
  OrientationStabilityResult,
  OrientationStabilitySample,
  OrientationViewState,
} from '../../../core';
import { colors, radii, spacing, typography } from '../../theme';

type CaptureState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'CALIBRATION_SETTLING';
      readonly signal: object;
      readonly afterSampleSeq?: number;
    }
  | {
      readonly kind: 'WAITING_FOR_AUTO_SAMPLE';
      readonly afterSampleSeq?: number;
    }
  | {
      readonly kind: 'COLLECTING';
      readonly elapsedMs: number;
      readonly sampleCount: number;
    }
  | {
      readonly kind: 'INTERRUPTED';
      readonly reason: 'STREAM_LOST' | 'AUTO_SAMPLE_TIMEOUT';
    }
  | { readonly kind: 'RESULT'; readonly result: OrientationStabilityResult };

const AUTO_SAMPLE_WAIT_TIMEOUT_MS = 5_000;

export interface OrientationStabilityPanelProps {
  orientationView: OrientationViewState;
  sampleSeq?: number;
  sampleReceivedAt?: number;
  /** A new object identity requests one post-calibration verification. */
  autoStartSignal?: object;
}

/**
 * Collects only the already-published attitude stream. It owns no poll,
 * sends no MSP command and changes no calibration or view offset.
 */
export default function OrientationStabilityPanel({
  orientationView,
  sampleSeq,
  sampleReceivedAt,
  autoStartSignal,
}: OrientationStabilityPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<CaptureState>({ kind: 'IDLE' });
  const samples = useRef<OrientationStabilitySample[]>([]);
  const startedAt = useRef<number | undefined>(undefined);
  const lastSampleSeq = useRef<number | undefined>(undefined);
  const lastAutoStartSignal = useRef<object | undefined>(undefined);
  const latestSampleSeq = useRef<number | undefined>(sampleSeq);
  latestSampleSeq.current = sampleSeq;

  const live = orientationView.status === 'LIVE';

  const startCapture = useCallback(() => {
    if (
      orientationView.status !== 'LIVE' ||
      sampleSeq === undefined ||
      sampleReceivedAt === undefined
    ) {
      return;
    }
    const first: OrientationStabilitySample = {
      atMs: sampleReceivedAt,
      rollDeg: orientationView.rollDeg,
      pitchDeg: orientationView.pitchDeg,
    };
    samples.current = [first];
    startedAt.current = sampleReceivedAt;
    lastSampleSeq.current = sampleSeq;
    setState({ kind: 'COLLECTING', elapsedMs: 0, sampleCount: 1 });
  }, [orientationView, sampleReceivedAt, sampleSeq]);

  useEffect(() => {
    if (
      autoStartSignal === undefined ||
      autoStartSignal === lastAutoStartSignal.current
    ) {
      return;
    }
    lastAutoStartSignal.current = autoStartSignal;
    samples.current = [];
    startedAt.current = undefined;
    lastSampleSeq.current = undefined;
    // The automatic result must include a genuinely newer attitude sample,
    // not a still-FRESH cache entry captured before the FC acknowledged the
    // calibration command.
    setState({
      kind: 'CALIBRATION_SETTLING',
      signal: autoStartSignal,
      afterSampleSeq: latestSampleSeq.current,
    });
  }, [autoStartSignal]);

  useEffect(() => {
    if (state.kind !== 'CALIBRATION_SETTLING') {
      return;
    }
    const timer = setTimeout(() => {
      setState({
        kind: 'WAITING_FOR_AUTO_SAMPLE',
        afterSampleSeq: state.afterSampleSeq,
      });
    }, 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (state.kind !== 'WAITING_FOR_AUTO_SAMPLE') {
      return;
    }
    const timer = setTimeout(() => {
      setState(current =>
        current.kind === 'WAITING_FOR_AUTO_SAMPLE'
          ? { kind: 'INTERRUPTED', reason: 'AUTO_SAMPLE_TIMEOUT' }
          : current,
      );
    }, AUTO_SAMPLE_WAIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== 'WAITING_FOR_AUTO_SAMPLE') {
      return;
    }
    if (
      orientationView.status !== 'LIVE' ||
      sampleSeq === undefined ||
      sampleReceivedAt === undefined
    ) {
      return;
    }
    if (
      state.afterSampleSeq !== undefined &&
      sampleSeq <= state.afterSampleSeq
    ) {
      return;
    }
    const first: OrientationStabilitySample = {
      atMs: sampleReceivedAt,
      rollDeg: orientationView.rollDeg,
      pitchDeg: orientationView.pitchDeg,
    };
    samples.current = [first];
    startedAt.current = sampleReceivedAt;
    lastSampleSeq.current = sampleSeq;
    setState({ kind: 'COLLECTING', elapsedMs: 0, sampleCount: 1 });
  }, [orientationView, sampleReceivedAt, sampleSeq, state]);

  useEffect(() => {
    if (state.kind !== 'COLLECTING') {
      return;
    }
    if (orientationView.status !== 'LIVE') {
      samples.current = [];
      startedAt.current = undefined;
      setState({ kind: 'INTERRUPTED', reason: 'STREAM_LOST' });
      return;
    }
    if (
      sampleSeq === undefined ||
      sampleReceivedAt === undefined ||
      sampleSeq === lastSampleSeq.current ||
      startedAt.current === undefined
    ) {
      return;
    }

    lastSampleSeq.current = sampleSeq;
    samples.current.push({
      atMs: sampleReceivedAt,
      rollDeg: orientationView.rollDeg,
      pitchDeg: orientationView.pitchDeg,
    });
    const elapsedMs = Math.max(0, sampleReceivedAt - startedAt.current);
    if (elapsedMs >= ORIENTATION_STABILITY_WINDOW_MS) {
      const result = analyzeOrientationStability(samples.current);
      samples.current = [];
      startedAt.current = undefined;
      setState({ kind: 'RESULT', result });
      return;
    }
    setState({
      kind: 'COLLECTING',
      elapsedMs,
      sampleCount: samples.current.length,
    });
  }, [orientationView, sampleReceivedAt, sampleSeq, state.kind]);

  const progress =
    state.kind === 'COLLECTING'
      ? Math.min(1, state.elapsedMs / ORIENTATION_STABILITY_WINDOW_MS)
      : 0;

  return (
    <View style={styles.container} testID="orientation-stability-panel">
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>
            {t('orientationStability.eyebrow')}
          </Text>
          <Text style={styles.title} accessibilityRole="header">
            {t('orientationStability.title')}
          </Text>
        </View>
        <View style={styles.readOnlyPill}>
          <Text style={styles.readOnlyText}>
            {t('orientationStability.readOnly')}
          </Text>
        </View>
      </View>

      <Text style={styles.description}>
        {t('orientationStability.description')}
      </Text>

      {state.kind === 'COLLECTING' && (
        <View
          style={styles.progressBlock}
          testID="orientation-stability-progress"
        >
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${progress * 100}%` }]}
            />
          </View>
          <Text style={styles.progressText}>
            {t('orientationStability.collecting', {
              seconds: Math.min(8, Math.floor(state.elapsedMs / 1000) + 1),
            })}
          </Text>
          <Text style={styles.keepStillText}>
            {t('orientationStability.keepStill')}
          </Text>
        </View>
      )}

      {state.kind === 'CALIBRATION_SETTLING' && (
        <View
          style={styles.progressBlock}
          testID="orientation-stability-settling"
        >
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, styles.progressFillComplete]} />
          </View>
          <Text style={styles.progressText}>
            {t('orientationStability.calibrationSettling')}
          </Text>
          <Text style={styles.keepStillText}>
            {t('orientationStability.keepStill')}
          </Text>
        </View>
      )}

      {state.kind === 'WAITING_FOR_AUTO_SAMPLE' && (
        <View
          style={styles.progressBlock}
          testID="orientation-stability-waiting-for-sample"
        >
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, styles.progressFillComplete]} />
          </View>
          <Text style={styles.progressText}>
            {t('orientationStability.waitingForLiveSample')}
          </Text>
          <Text style={styles.keepStillText}>
            {t('orientationStability.keepStill')}
          </Text>
        </View>
      )}

      {state.kind === 'INTERRUPTED' && (
        <Text
          style={styles.warningText}
          testID="orientation-stability-interrupted"
        >
          {t(
            state.reason === 'AUTO_SAMPLE_TIMEOUT'
              ? 'orientationStability.autoSampleTimeout'
              : 'orientationStability.interrupted',
          )}
        </Text>
      )}

      {state.kind === 'RESULT' && <ResultView result={state.result} />}

      {state.kind !== 'COLLECTING' &&
        state.kind !== 'CALIBRATION_SETTLING' &&
        state.kind !== 'WAITING_FOR_AUTO_SAMPLE' && (
          <Pressable
            onPress={startCapture}
            disabled={!live}
            accessibilityRole="button"
            accessibilityState={{ disabled: !live }}
            style={[styles.action, !live && styles.actionDisabled]}
            testID="orientation-stability-start"
          >
            <Text
              style={[styles.actionText, !live && styles.actionTextDisabled]}
            >
              {t(
                state.kind === 'RESULT'
                  ? 'orientationStability.repeatAction'
                  : 'orientationStability.startAction',
              )}
            </Text>
          </Pressable>
        )}
      {!live &&
        state.kind !== 'COLLECTING' &&
        state.kind !== 'CALIBRATION_SETTLING' &&
        state.kind !== 'WAITING_FOR_AUTO_SAMPLE' && (
          <Text style={styles.unavailableText}>
            {t('orientationStability.unavailable')}
          </Text>
        )}
    </View>
  );
}

function ResultView({
  result,
}: {
  result: OrientationStabilityResult;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (result.kind === 'INSUFFICIENT') {
    return (
      <Text
        style={styles.warningText}
        testID="orientation-stability-result-insufficient"
      >
        {t('orientationStability.results.INSUFFICIENT')}
      </Text>
    );
  }
  const tone =
    result.kind === 'STABLE_LEVEL'
      ? colors.success
      : result.kind === 'STABLE_OFFSET'
      ? colors.warning
      : colors.error;
  return (
    <View
      style={[styles.result, { borderColor: tone }]}
      testID={`orientation-stability-result-${result.kind}`}
    >
      <Text style={[styles.resultTitle, { color: tone }]}>
        {t(`orientationStability.results.${result.kind}`)}
      </Text>
      <View style={styles.metricsRow}>
        <Metric
          label={t('orientationStability.meanRoll')}
          value={`${result.meanRollDeg.toFixed(1)}°`}
        />
        <Metric
          label={t('orientationStability.meanPitch')}
          value={`${result.meanPitchDeg.toFixed(1)}°`}
        />
      </View>
      <Text style={styles.metricCaption}>
        {t('orientationStability.movement', {
          roll: result.rollSpanDeg.toFixed(1),
          pitch: result.pitchSpanDeg.toFixed(1),
        })}
      </Text>
      <Text style={styles.metricCaption}>
        {t('orientationStability.drift', {
          roll: result.rollDriftDeg.toFixed(1),
          pitch: result.pitchDriftDeg.toFixed(1),
        })}
      </Text>
      <Text style={styles.disclaimer}>
        {t('orientationStability.resultDisclaimer')}
      </Text>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerCopy: { flex: 1 },
  eyebrow: { ...typography.eyebrow, color: colors.info },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: 2,
  },
  readOnlyPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  readOnlyText: { ...typography.caption, color: colors.textSecondary },
  description: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  progressBlock: { marginTop: spacing.md },
  progressTrack: {
    height: 7,
    borderRadius: radii.pill,
    overflow: 'hidden',
    backgroundColor: colors.backgroundRaised,
  },
  progressFill: { height: '100%', backgroundColor: colors.accent },
  progressFillComplete: { width: '100%' },
  progressText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.sm,
    fontWeight: '700',
  },
  keepStillText: {
    ...typography.caption,
    color: colors.warning,
    marginTop: spacing.xs,
  },
  warningText: {
    ...typography.body,
    color: colors.warning,
    marginTop: spacing.md,
  },
  result: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
  },
  resultTitle: { ...typography.sectionTitle },
  metricsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  metric: {
    flex: 1,
    padding: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
  },
  metricLabel: { ...typography.caption, color: colors.textSecondary },
  metricValue: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: spacing.xs,
    writingDirection: 'ltr',
  },
  metricCaption: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  disclaimer: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.md,
  },
  action: {
    minHeight: 48,
    marginTop: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  actionDisabled: {
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  actionText: {
    ...typography.body,
    color: colors.accentText,
    fontWeight: '700',
  },
  actionTextDisabled: { color: colors.disabled },
  unavailableText: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
});
