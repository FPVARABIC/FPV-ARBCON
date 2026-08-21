import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, fonts, radii, spacing, typography } from '../../theme';
import {PROSE_MEASURE} from '../../theme';

const MIN_INSTRUMENT_SIZE = 112;
const MAX_INSTRUMENT_SIZE = 156;
const STACKED_LAYOUT_THRESHOLD = 260;
// At 45deg bank the viewport's corner reaches ~0.707 * size from the
// centre in the moving plane. Add the maximum pitch travel (0.28 * size)
// and a small anti-aliasing margin: a 2.1x plane cannot expose a square
// edge at any supported roll/pitch combination.
const ARTIFICIAL_HORIZON_WORLD_SCALE = 2.1;
const ARTIFICIAL_HORIZON_PITCH_LIMIT_DEG = 30;
const COMPASS_BEARINGS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => index * 30),
);
/**
 * SETUP P3: relative graduations, not cardinal points. These are the
 * quarter-turn marks of the dial - 0 is the operator's own reset
 * reference, not north. Rendered as degree numbers so nothing about them
 * can be read as a magnetic bearing.
 */
const RELATIVE_MARKS = Object.freeze([0, 90, 180, 270]);

/** Latin digits with a degree sign, isolated LTR by the style below so
 * the surrounding Arabic paragraph cannot reorder them. */
function formatRelativeMark(mark: number): string {
  return `${mark}°`;
}

export type FlightInstrumentsStatus = 'LIVE' | 'STALE' | 'WAITING' | 'ERROR';

export interface FlightInstrumentsProps {
  status: FlightInstrumentsStatus;
  stageWidth: number;
  fontScale?: number;
  /** Tablet hero layout: two independent compact cards stacked beside 3D. */
  layout?: 'row' | 'sidebar';
  /** Pure presentation scale; 0.8 is used for the requested 20% reduction. */
  sizeScale?: number;
  rollDeg?: number;
  pitchDeg?: number;
  headingDeg?: number;
}

export function shouldStackFlightInstruments(
  stageWidth: number,
  fontScale: number,
): boolean {
  const safeWidth = Number.isFinite(stageWidth) ? stageWidth : 260;
  const safeFontScale =
    Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return safeWidth / safeFontScale < STACKED_LAYOUT_THRESHOLD;
}

export function computeFlightInstrumentSize(
  stageWidth: number,
  stacked = false,
  sizeScale = 1,
): number {
  // The panel has horizontal padding on both sides. The side-by-side
  // layout also reserves one inter-gauge gap; a stacked layout does not.
  const available = Number.isFinite(stageWidth)
    ? stacked
      ? stageWidth - spacing.md * 2
      : (stageWidth - spacing.md * 3) / 2
    : 130;
  const base = Math.min(
    MAX_INSTRUMENT_SIZE,
    Math.max(MIN_INSTRUMENT_SIZE, available),
  );
  const safeScale =
    Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1;
  return Math.max(MIN_INSTRUMENT_SIZE, Math.round(base * safeScale));
}

export function normalizeHeadingDegrees(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return ((value % 360) + 360) % 360;
}

export function normalizeRollDegrees(value: number): number {
  const normalized = normalizeHeadingDegrees(value);
  return normalized > 180 ? normalized - 360 : normalized;
}

export function roundHeadingDegrees(value: number): number {
  return Math.round(normalizeHeadingDegrees(value)) % 360;
}

export function deriveArtificialHorizonTransform(
  rollDeg: number,
  pitchDeg: number,
  size: number,
): { readonly rollDeg: number; readonly pitchOffsetPx: number } {
  const safePitch = Number.isFinite(pitchDeg)
    ? Math.max(
        -ARTIFICIAL_HORIZON_PITCH_LIMIT_DEG,
        Math.min(ARTIFICIAL_HORIZON_PITCH_LIMIT_DEG, pitchDeg),
      )
    : 0;
  return {
    // The horizon moves opposite to the aircraft's bank.
    rollDeg: -normalizeRollDegrees(rollDeg),
    // Nose-up means more sky is visible, so the horizon moves down.
    pitchOffsetPx:
      (safePitch / ARTIFICIAL_HORIZON_PITCH_LIMIT_DEG) * size * 0.28,
  };
}

export function isArtificialHorizonPitchOffScale(pitchDeg: number): boolean {
  return (
    Number.isFinite(pitchDeg) &&
    Math.abs(pitchDeg) > ARTIFICIAL_HORIZON_PITCH_LIMIT_DEG
  );
}

function formatHeading(value: number): string {
  return `${String(roundHeadingDegrees(value)).padStart(3, '0')}°`;
}


/** Static ladder marks are isolated from the 20Hz pose updates. Only the
 * parent plane transform changes when a new sample arrives. */
const PitchLadderMarks = memo(function RenderPitchLadderMarks({
  size,
  worldSize,
}: {
  size: number;
  worldSize: number;
}): React.JSX.Element {
  const ladderGap = size * 0.115;
  const ladderWidths = [0.34, 0.23, 0.15];
  return (
    <>
      {[-3, -2, -1, 1, 2, 3].map(step => (
        <View
          key={step}
          style={[
            styles.pitchLadder,
            {
              width: size * ladderWidths[Math.abs(step) - 1],
              left:
                worldSize / 2 - (size * ladderWidths[Math.abs(step) - 1]) / 2,
              top: worldSize / 2 + step * ladderGap,
            },
          ]}
        />
      ))}
    </>
  );
});

/** The compass scale never changes for a fixed gauge size. Keeping it in
 * a memoized child means each attitude sample updates one dial transform,
 * not sixteen tick/label elements. */
const CompassDialMarks = memo(function RenderCompassDialMarks({
  size,
}: {
  size: number;
}): React.JSX.Element {
  const center = size / 2;
  const tickRadius = size * 0.405;
  const labelRadius = size * 0.31;
  return (
    <>
      {COMPASS_BEARINGS.map(bearing => {
        const radians = (bearing * Math.PI) / 180;
        const major = bearing % 90 === 0;
        return (
          <View
            key={`tick-${bearing}`}
            style={[
              styles.compassTick,
              major && styles.compassTickMajor,
              {
                left: center + Math.sin(radians) * tickRadius - 1,
                top: center - Math.cos(radians) * tickRadius - (major ? 6 : 4),
                transform: [{ rotate: `${bearing}deg` }],
              },
            ]}
          />
        );
      })}
      {/* SETUP P3: the N/E/S/W cardinal rose is GONE, deliberately.
          P0 proved this dial is driven by FC attitude yaw offset by the
          operator's own reset point - a RELATIVE direction with no
          magnetometer guarantee. Cardinal letters and a red north needle
          are the visual language of a magnetic compass, and they made
          the instrument claim more than the data can support. They were
          also the only four non-Cairo text nodes on the whole Setup
          surface; removing them closes that inconsistency at the same
          time, by deleting the misleading thing rather than restyling
          it. The graduated ticks remain: they show RELATIVE rotation,
          which is exactly what the yaw value is. */}
      {RELATIVE_MARKS.map(mark => {
        const radians = (mark * Math.PI) / 180;
        return (
          <Text
            key={`mark-${mark}`}
            style={[
              styles.relativeMark,
              {
                /* Half the box, so the label centres on its own tick.
                   Must track RELATIVE_MARK_BOX_WIDTH below. */
                left: center + Math.sin(radians) * labelRadius - 15,
                top: center - Math.cos(radians) * labelRadius - 9,
                transform: [{ rotate: `${mark}deg` }],
              },
            ]}
            numberOfLines={1}
          >
            {formatRelativeMark(mark)}
          </Text>
        );
      })}
    </>
  );
});

function ArtificialHorizon({
  size,
  rollDeg,
  pitchDeg,
  available,
  card,
}: {
  size: number;
  rollDeg: number;
  pitchDeg: number;
  available: boolean;
  card?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const worldSize = size * ARTIFICIAL_HORIZON_WORLD_SCALE;
  const transform = deriveArtificialHorizonTransform(rollDeg, pitchDeg, size);
  const pitchOffScale = isArtificialHorizonPitchOffScale(pitchDeg);
  const aircraftWingWidth = size * 0.29;
  const aircraftWingThickness = Math.max(3, size * 0.022);
  const aircraftCenterSize = Math.max(8, size * 0.064);

  return (
    <View
      style={[
        styles.instrumentColumn,
        { width: card ? size + spacing.sm * 2 : size },
        card && styles.sidebarInstrumentCard,
      ]}
    >
      <Text style={styles.instrumentLabel} numberOfLines={2}>
        {t('flightInstruments.horizon')}
      </Text>
      <View
        style={[
          styles.instrumentFace,
          { width: size, height: size, borderRadius: size / 2 },
          !available && styles.instrumentUnavailable,
        ]}
        accessible
        accessibilityLabel={
          available
            ? t('flightInstruments.horizonAccessibility', {
                roll: rollDeg.toFixed(1),
                pitch: pitchDeg.toFixed(1),
              })
            : t('flightInstruments.unavailableAccessibility')
        }
        testID="artificial-horizon"
      >
        <View
          style={[
            styles.horizonWorld,
            {
              width: worldSize,
              height: worldSize,
              left: (size - worldSize) / 2,
              top: (size - worldSize) / 2,
              transform: [
                { translateY: transform.pitchOffsetPx },
                { rotate: `${transform.rollDeg}deg` },
              ],
            },
          ]}
          testID="artificial-horizon-moving-world"
        >
          <View style={styles.sky} />
          <View style={styles.ground} />
          <View style={styles.horizonLine} />
          <PitchLadderMarks size={size} worldSize={worldSize} />
        </View>

        <View style={styles.bankReference} />
        <View
          style={[
            styles.aircraftWing,
            {
              left: size * 0.17,
              top: size / 2 - aircraftWingThickness / 2,
              width: aircraftWingWidth,
              height: aircraftWingThickness,
            },
          ]}
        />
        <View
          style={[
            styles.aircraftWing,
            {
              right: size * 0.17,
              top: size / 2 - aircraftWingThickness / 2,
              width: aircraftWingWidth,
              height: aircraftWingThickness,
            },
          ]}
        />
        <View
          style={[
            styles.aircraftCenter,
            {
              left: size / 2 - aircraftCenterSize / 2,
              top: size / 2 - aircraftCenterSize / 2,
              width: aircraftCenterSize,
              height: aircraftCenterSize,
              borderRadius: aircraftCenterSize / 2,
            },
          ]}
        />
        {available && pitchOffScale && (
          <View
            style={styles.pitchOffScalePill}
            testID="artificial-horizon-pitch-off-scale"
          >
            <Text style={styles.pitchOffScaleText}>
              {t(
                pitchDeg > 0
                  ? 'flightInstruments.pitchOffScaleHigh'
                  : 'flightInstruments.pitchOffScaleLow',
              )}
            </Text>
          </View>
        )}
        {!available && (
          <View
            style={styles.unavailableOverlay}
            testID="artificial-horizon-overlay"
          >
            <Text style={styles.unavailableMark}>—</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function DirectionCompass({
  size,
  headingDeg,
  available,
  card,
}: {
  size: number;
  headingDeg: number;
  available: boolean;
  card?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const heading = normalizeHeadingDegrees(headingDeg);

  return (
    <View
      style={[
        styles.instrumentColumn,
        { width: card ? size + spacing.sm * 2 : size },
        card && styles.sidebarInstrumentCard,
      ]}
    >
      <Text style={styles.instrumentLabel} numberOfLines={2}>
        {t('flightInstruments.compass')}
      </Text>
      <View
        style={[
          styles.instrumentFace,
          styles.compassFace,
          { width: size, height: size, borderRadius: size / 2 },
          !available && styles.instrumentUnavailable,
        ]}
        accessible
        accessibilityLabel={
          available
            ? t('flightInstruments.compassAccessibility', {
                heading: roundHeadingDegrees(heading),
              })
            : t('flightInstruments.unavailableAccessibility')
        }
        testID="direction-compass"
      >
        <View
          style={[
            styles.compassDial,
            { transform: [{ rotate: `${-heading}deg` }] },
          ]}
          testID="direction-compass-dial"
        >
          <CompassDialMarks size={size} />
        </View>

        {/* The fixed lubber line: where the aircraft's own nose points
            on this dial. Not a north pointer - it never moves. */}
        <View style={styles.compassTopMarker} />
        <View style={styles.aircraftPlanNose} />
        <View style={styles.aircraftPlanFuselage} />
        <View style={styles.aircraftPlanWings} />
        <View style={styles.aircraftPlanTail} />
        <View style={styles.aircraftPlanCenter} />
        {available && (
          <View
            style={styles.headingValuePill}
            testID="direction-compass-value"
          >
            <Text style={styles.headingValue}>{formatHeading(heading)}</Text>
          </View>
        )}
        {!available && (
          <View
            style={styles.unavailableOverlay}
            testID="direction-compass-overlay"
          >
            <Text style={styles.unavailableMark}>—</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function FlightInstruments({
  status,
  stageWidth,
  fontScale = 1,
  layout = 'row',
  sizeScale = 1,
  rollDeg = 0,
  pitchDeg = 0,
  headingDeg = 0,
}: FlightInstrumentsProps): React.JSX.Element {
  const sidebar = layout === 'sidebar';
  const stacked = sidebar || shouldStackFlightInstruments(stageWidth, fontScale);
  const size = computeFlightInstrumentSize(stageWidth, stacked, sizeScale);
  const available = status === 'LIVE' || status === 'STALE';

  return (
    <View
      style={[styles.container, sidebar && styles.sidebarContainer]}
      testID="flight-instruments"
      accessibilityState={{ disabled: !available }}
    >
      {/* SETUP P3: the internal header row is GONE. It carried its own
          eyebrow ("أدوات الاتجاه"), its own title and its own status
          pill - and it renders INSIDE OrientationHero, which already has
          all three. P0 measured "مباشر" appearing twice in one hero for
          exactly this reason. One section, one state indicator; the
          hero's badge is the survivor because it speaks for the whole
          orientation section, not just these two dials. */}

      <View
        style={[
          styles.instrumentsRow,
          stacked && styles.instrumentsRowStacked,
          sidebar && styles.instrumentsRowSidebar,
        ]}
        testID={stacked ? 'flight-instruments-stacked' : 'flight-instruments-row'}
      >
        {sidebar ? (
          <>
            <DirectionCompass
              size={size}
              headingDeg={headingDeg}
              available={available}
              card
            />
            <ArtificialHorizon
              size={size}
              rollDeg={rollDeg}
              pitchDeg={pitchDeg}
              available={available}
              card
            />
          </>
        ) : (
          <>
            <ArtificialHorizon
              size={size}
              rollDeg={rollDeg}
              pitchDeg={pitchDeg}
              available={available}
            />
            <DirectionCompass
              size={size}
              headingDeg={headingDeg}
              available={available}
            />
          </>
        )}
      </View>
      {/* The relative-direction caveat lives once, on the hero's own
          note line - repeating it under the dials spent 44px saying the
          same sentence twice. */}
    </View>
  );
}

export default memo(FlightInstruments);

const styles = StyleSheet.create({
  container: {
    width: '100%',
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  sidebarContainer: {
    width: 'auto',
    marginTop: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  headerCopy: { flex: 1 },
  eyebrow: { ...typography.eyebrow, color: colors.info },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: 1,
  },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  statusPillWaiting: { backgroundColor: colors.surfaceAlt },
  statusPillStale: { backgroundColor: '#FFF4D8' },
  statusPillError: { backgroundColor: '#FFF0F1' },
  statusText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700', maxWidth: PROSE_MEASURE},
  statusTextWaiting: { color: colors.textMuted },
  statusTextStale: { color: colors.warning },
  statusTextError: { color: colors.error },
  instrumentsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  instrumentsRowStacked: {
    flexDirection: 'column',
    alignItems: 'center',
  },
  instrumentsRowSidebar: {
    marginTop: 0,
    gap: spacing.sm,
  },
  instrumentColumn: { alignItems: 'center' },
  sidebarInstrumentCard: {
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  instrumentLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  instrumentFace: {
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#07151D',
  },
  instrumentUnavailable: { opacity: 0.55 },
  horizonWorld: { position: 'absolute', overflow: 'hidden' },
  sky: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '50%',
    backgroundColor: '#2377A4',
  },
  ground: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '50%',
    backgroundColor: '#79512F',
  },
  horizonLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 2,
    backgroundColor: colors.white,
  },
  pitchLadder: {
    position: 'absolute',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  bankReference: {
    position: 'absolute',
    top: 7,
    left: '50%',
    marginLeft: -5,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.white,
  },
  aircraftWing: {
    position: 'absolute',
    backgroundColor: colors.warning,
    borderRadius: 2,
  },
  aircraftCenter: {
    position: 'absolute',
    backgroundColor: colors.warning,
    borderWidth: 2,
    borderColor: '#07151D',
  },
  pitchOffScalePill: {
    position: 'absolute',
    top: 23,
    left: '50%',
    width: 76,
    marginLeft: -38,
    paddingVertical: 2,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(3, 15, 20, 0.82)',
    borderWidth: 1,
    borderColor: colors.warning,
  },
  pitchOffScaleText: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
    textAlign: 'center',
  },
  compassFace: { backgroundColor: '#091921' },
  compassDial: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  compassTick: {
    position: 'absolute',
    width: 2,
    height: 8,
    borderRadius: 1,
    backgroundColor: colors.textMuted,
  },
  compassTickMajor: { height: 12, backgroundColor: colors.white },
  /* SETUP P3: the graduation labels. `fontFamily` is now set explicitly -
     P0 measured the four cardinal letters this replaces as the ONLY
     non-Cairo text nodes on the Setup surface, because this style set
     size/weight/colour and silently inherited the platform default
     family. There is no `cardinalNorth` variant any more: a red north
     needle is exactly the claim this instrument may not make. */
  /**
   * 30px, NOT 24 - a clipping defect the R9 geometry sweep measured.
   *
   * "180°" and "270°" are four glyphs at 11px bold, which is roughly
   * 27px wide. In a 24px box they wrapped to a second line inside an
   * 18px-tall box, so the browser reported content 24x37 in a 24x18
   * frame: the bottom half of both labels was cut off, on every width.
   * "0°" and "90°" fit, which is why it survived unnoticed.
   *
   * The FONT IS UNCHANGED at 11px - this widens the box the glyphs sit
   * in, and numberOfLines={1} above makes a future longer label
   * truncate visibly rather than silently wrap out of view.
   */
  relativeMark: {
    position: 'absolute',
    width: 30,
    height: 18,
    textAlign: 'center',
    color: colors.white,
    fontFamily: fonts.family,
    fontSize: 11,
    lineHeight: 18,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  compassTopMarker: {
    position: 'absolute',
    top: 3,
    left: '50%',
    marginLeft: -5,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: colors.warning,
  },
  aircraftPlanNose: {
    position: 'absolute',
    left: '50%',
    top: '29%',
    marginLeft: -5,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 12,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.warning,
  },
  aircraftPlanFuselage: {
    position: 'absolute',
    left: '50%',
    top: '36%',
    width: 3,
    height: '35%',
    marginLeft: -1.5,
    borderRadius: 2,
    backgroundColor: colors.warning,
  },
  aircraftPlanWings: {
    position: 'absolute',
    left: '30%',
    right: '30%',
    top: '49%',
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.warning,
  },
  aircraftPlanTail: {
    position: 'absolute',
    left: '40%',
    right: '40%',
    top: '66%',
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.warning,
  },
  aircraftPlanCenter: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 8,
    height: 8,
    marginLeft: -4,
    marginTop: -4,
    borderRadius: 4,
    backgroundColor: '#07151D',
    borderWidth: 2,
    borderColor: colors.warning,
  },
  headingValuePill: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    width: 52,
    marginLeft: -26,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(3, 15, 20, 0.82)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  headingValue: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.white,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  unavailableOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5, 17, 23, 0.55)',
  },
  unavailableMark: { fontSize: 28, color: colors.textMuted, fontWeight: '700' },
  relativeNote: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
});
