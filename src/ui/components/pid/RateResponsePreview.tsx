/**
 * A COMPACT PICTURE OF THE RATE CURVE - AND NOTHING MORE.
 *
 * Two rules shaped this component, both learned the hard way elsewhere in
 * this app.
 *
 * IT IS A SUPPORT TOOL, NOT THE PAGE. The Motors screen once grew a diagram
 * that pushed every control it existed to explain below the fold, and the
 * fix was to give the visual a budget. This one has a bounded height that
 * never exceeds a fraction of the viewport, and the sliders stay above it on
 * a phone.
 *
 * IT IS MATHEMATICS, NOT TELEMETRY. Nothing here is read from the aircraft
 * while it is flying. The curve is `rateFormulaEngine` evaluated at forty-one
 * stick positions, so the label says "معاينة" and never "مباشر". If a live
 * stick position is ever drawn on top of it, only that DOT is live; the line
 * stays a projection.
 *
 * There is no rate mathematics in this file. It asks `ratesPresentation` for
 * a curve and draws the points it is given.
 */

import React, {useMemo} from 'react';
import {StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Svg, {Line, Polyline} from 'react-native-svg';
import {ChoiceChips} from '../controls';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../../theme';
import {
  axisMaximum,
  buildRateCurve,
  previewCopy,
  ratePreviewAvailability,
} from '../../presentation/ratesPresentation';
import type {RateAxisSettings, RatesType} from '../../../core/state/rateFormulaEngine';

/** Axis order is FIXED. RTL changes text alignment, never Roll/Pitch/Yaw. */
export const PREVIEW_AXES: readonly {key: 'roll' | 'pitch' | 'yaw'; label: string}[] = Object.freeze([
  Object.freeze({key: 'roll' as const, label: 'Roll'}),
  Object.freeze({key: 'pitch' as const, label: 'Pitch'}),
  Object.freeze({key: 'yaw' as const, label: 'Yaw'}),
]);

/**
 * The height budget.
 *
 * A share of the viewport, clamped, so the chart is readable on a desktop
 * and still small enough on a 390px phone that the controls it supports are
 * not pushed a screen away.
 */
export const PREVIEW_MIN_HEIGHT = 96;
export const PREVIEW_MAX_HEIGHT = 168;
export const PREVIEW_VIEWPORT_SHARE = 0.22;

export function previewHeightFor(viewportHeight: number): number {
  const budget = Math.round(viewportHeight * PREVIEW_VIEWPORT_SHARE);
  return Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, budget));
}

export interface RateResponsePreviewProps {
  readonly type: RatesType;
  /** Raw wire settings per axis, exactly as MSP_RC_TUNING carries them. */
  readonly axes: Readonly<Record<'roll' | 'pitch' | 'yaw', RateAxisSettings>>;
  /** The board's stored values, drawn faintly behind the draft. */
  readonly baseline?: Readonly<Record<'roll' | 'pitch' | 'yaw', RateAxisSettings>>;
  readonly selectedAxis: 'roll' | 'pitch' | 'yaw';
  readonly onSelectAxis: (axis: 'roll' | 'pitch' | 'yaw') => void;
  readonly testID?: string;
}

const VIEW_WIDTH = 200;
const VIEW_HEIGHT = 100;

function toPolyline(points: readonly {stick: number; degPerSec: number}[], maxima: number): string {
  const scale = maxima <= 0 ? 1 : maxima;
  return points
    .map(point => {
      // Stick -1..1 maps left to right. THIS IS NOT MIRRORED UNDER RTL:
      // the horizontal axis is a signed number line, and reversing it would
      // make left stick read as right stick.
      const x = ((point.stick + 1) / 2) * VIEW_WIDTH;
      const y = VIEW_HEIGHT / 2 - (point.degPerSec / scale) * (VIEW_HEIGHT / 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export default function RateResponsePreview({
  type, axes, baseline, selectedAxis, onSelectAxis, testID = 'pid-rate-preview',
}: RateResponsePreviewProps): React.JSX.Element {
  const {height} = useWindowDimensions();
  const chartHeight = previewHeightFor(height);
  const availability = ratePreviewAvailability(type);
  const copy = previewCopy(availability);

  const draftCurve = useMemo(
    () => (copy.available ? buildRateCurve(type, axes[selectedAxis]) : undefined),
    [axes, copy.available, selectedAxis, type],
  );
  const baselineCurve = useMemo(
    () => (copy.available && baseline !== undefined ? buildRateCurve(type, baseline[selectedAxis]) : undefined),
    [baseline, copy.available, selectedAxis, type],
  );
  const maximum = copy.available ? axisMaximum(type, axes[selectedAxis]) : undefined;

  const axisChips = PREVIEW_AXES.map(axis => ({key: axis.key, label: axis.label}));

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.headingRow}>
        <Text style={styles.title}>{copy.title}</Text>
        {copy.available ? <Text style={styles.mathNote}>حساب رياضي من قيم الملف، ليس قراءة حيّة</Text> : null}
      </View>

      {copy.available ? (
        <>
          <ChoiceChips
            options={axisChips}
            selectedKey={selectedAxis}
            onSelect={onSelectAxis}
            accessibilityLabel="محور المعاينة"
            testID={`${testID}-axis`}
          />
          <View
            style={[styles.chart, {height: chartHeight}]}
            testID={`${testID}-chart`}
            accessible
            accessibilityRole="image"
            accessibilityLabel={
              maximum === undefined
                ? `${PREVIEW_AXES.find(axis => axis.key === selectedAxis)?.label}: لا يتوفر حساب`
                : `${PREVIEW_AXES.find(axis => axis.key === selectedAxis)?.label}: الحد المتوقع ${Math.round(maximum)} درجة/ثانية`
            }
          >
            <Svg width="100%" height="100%" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none">
              <Line x1={0} y1={VIEW_HEIGHT / 2} x2={VIEW_WIDTH} y2={VIEW_HEIGHT / 2} stroke={colors.border} strokeWidth={0.75} />
              <Line x1={VIEW_WIDTH / 2} y1={0} x2={VIEW_WIDTH / 2} y2={VIEW_HEIGHT} stroke={colors.border} strokeWidth={0.75} />
              {baselineCurve !== undefined ? (
                <Polyline
                  points={toPolyline(baselineCurve.points, Math.max(draftCurve?.maxDegPerSec ?? 0, baselineCurve.maxDegPerSec))}
                  fill="none"
                  stroke={colors.textMuted}
                  strokeWidth={1}
                  testID={`${testID}-baseline`}
                />
              ) : null}
              {draftCurve !== undefined ? (
                <Polyline
                  points={toPolyline(draftCurve.points, Math.max(draftCurve.maxDegPerSec, baselineCurve?.maxDegPerSec ?? 0))}
                  fill="none"
                  stroke={colors.accentStrong}
                  strokeWidth={2}
                  testID={`${testID}-curve`}
                />
              ) : null}
            </Svg>
          </View>
          <View style={styles.footRow}>
            <Text style={styles.axisCaption}>وضع العصا ←→ سرعة الدوران °/s</Text>
            {maximum === undefined ? null : (
              <Text style={styles.maxReadout} testID={`${testID}-max`}>
                {`أقصى ${PREVIEW_AXES.find(axis => axis.key === selectedAxis)?.label}: ${Math.round(maximum)}°/s`}
              </Text>
            )}
          </View>
          {draftCurve?.clipped === true ? (
            <Text style={styles.clipNote} testID={`${testID}-clipped`}>
              {`محدود عند ${axes[selectedAxis].rateLimit}°/s`}
            </Text>
          ) : null}
        </>
      ) : (
        <View style={styles.unavailable} testID={`${testID}-unavailable`}>
          <Text style={styles.unavailableText}>{copy.explanation}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.surface, padding: spacing.md, gap: spacing.sm,
  },
  headingRow: {gap: 2},
  title: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  mathNote: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  chart: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised, overflow: 'hidden',
  },
  footRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm},
  axisCaption: {...typography.caption, color: colors.textMuted, writingDirection: 'rtl'},
  maxReadout: {...typography.label, color: colors.accentStrong, fontVariant: ['tabular-nums']},
  clipNote: {...typography.caption, color: colors.warning, textAlign: 'right'},
  unavailable: {
    borderRadius: radii.sm, borderWidth: 1, borderColor: colors.warning,
    backgroundColor: colors.warningSoft, padding: spacing.sm,
  },
  unavailableText: {...typography.caption, color: colors.warning, textAlign: 'right', writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
});
