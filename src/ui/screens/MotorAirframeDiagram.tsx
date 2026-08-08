/**
 * Purpose-built Quad X airframe reference for the Motors workspace.
 *
 * A view-only geometry layer: the slot handed to onSelectSlot is the same
 * number printed on the node, and no value here can reach a motor command
 * or relax a safety gate. Position and direction are an EXPECTED
 * reference for a Quad X frame, never a measurement from the aircraft -
 * an MSP acknowledgement proves reception, not rotation.
 *
 * SIZING. The stage used to be capped at 156px on every screen, which a
 * real operator reported as unreadable: not recognisably a Quad X, front
 * unclear, M1-M4 unclear, CW/CCW unclear. It now scales with the viewport
 * through the shared layout tiers, and every internal dimension derives
 * from the stage size rather than being hard-coded, so the frame, the
 * rotors, the numbers and the rotation arrows grow together.
 * MOTOR_AIRFRAME_STAGE_MIN_WIDTH keeps the narrowest phone case at the
 * previously-audited touch-target size.
 *
 * MEANING NEVER DEPENDS ON COLOUR: every state also carries an Arabic
 * text badge on the node itself and a matching legend entry.
 */

import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type {
  MotorPhysicalPosition,
  MotorRotationDirection,
} from '../../core/state/motorVerificationModel';
import { MOTOR_TEST_EXPECTED_CONFIGURATION } from '../../core/state/motorVerificationModel';
import { colors, radii, spacing, typography } from '../theme';
import { resolveLayoutTier } from '../theme/layout';

export interface MotorAirframeEntry {
  readonly slot: number;
  readonly position: MotorPhysicalPosition;
  readonly direction: MotorRotationDirection;
}

/**
 * What the diagram may say about one output right now. SUBMITTED /
 * ACKNOWLEDGED / STOPPING mirror the controller's own published pulse
 * record. UNSAFE means the app cannot describe the output truthfully (a
 * fault, or a stop it could not confirm).
 */
export type MotorSlotActivity =
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'STOPPING'
  | 'UNSAFE';

export interface MotorAirframeDiagramProps {
  readonly entries: readonly MotorAirframeEntry[];
  readonly selectedSlot: number;
  readonly liveSlot?: number;
  /** The controller's current verdict for `liveSlot`. */
  readonly liveActivity?: MotorSlotActivity;
  readonly verifiedSlots?: readonly number[];
  readonly onSelectSlot: (slot: number) => void;
}

/**
 * The smallest stage, kept from the previously-audited phone layout so a
 * narrow device still gets real 44dp touch targets.
 */
export const MOTOR_AIRFRAME_STAGE_MIN_WIDTH = 156;
/** Back-compatible alias for the historical constant name. */
export const MOTOR_AIRFRAME_STAGE_MAX_WIDTH = MOTOR_AIRFRAME_STAGE_MIN_WIDTH;
export const MOTOR_AIRFRAME_STAGE_ASPECT_RATIO = 1;

/**
 * How wide the stage may be for a given viewport. A Quad X only reads as
 * a Quad X when the arms are long enough to separate the rotors, so the
 * desktop tiers get a genuinely large diagram rather than a phone glyph
 * centred in a monitor.
 */
export function computeAirframeStageWidth(
  windowWidth: number,
  fontScale = 1,
): number {
  const tier = resolveLayoutTier(windowWidth, fontScale);
  const byTier =
    tier === 'desktopWide'
      ? 460
      : tier === 'desktop'
      ? 400
      : tier === 'wide'
      ? 330
      : tier === 'tablet'
      ? 280
      : 210;
  const available = Number.isFinite(windowWidth)
    ? Math.max(0, windowWidth - 48)
    : byTier;
  return Math.max(
    MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
    Math.min(byTier, Math.max(MOTOR_AIRFRAME_STAGE_MIN_WIDTH, available)),
  );
}

// Emission order is explicit and mirrors the accepted identity test: right
// first, left second. The row itself has an explicit RTL direction, so right
// remains on the physical right regardless of the host device's locale.
const VISUAL_POSITION_ORDER: readonly MotorPhysicalPosition[] = Object.freeze([
  'FRONT_RIGHT',
  'FRONT_LEFT',
  'REAR_RIGHT',
  'REAR_LEFT',
]);

export function orderAirframeEntries(
  entries: readonly MotorAirframeEntry[],
): readonly MotorAirframeEntry[] {
  return Object.freeze(
    VISUAL_POSITION_ORDER.map(position => {
      const entry = entries.find(candidate => candidate.position === position);
      if (entry === undefined) {
        throw new Error(`Missing motor reference for ${position}`);
      }
      return entry;
    }),
  );
}

export type MotorGlyphRow = 'FRONT' | 'REAR';
export type MotorGlyphSide = 'RIGHT' | 'LEFT';

export interface MotorGlyphCell {
  /** MSP output slot, 1..4 - the same number pulseMotor receives. */
  readonly slot: number;
  readonly row: MotorGlyphRow;
  readonly side: MotorGlyphSide;
  readonly positionKey: string;
  readonly directionKey: string;
}

const POSITION_GEOMETRY: Record<
  MotorPhysicalPosition,
  { row: MotorGlyphRow; side: MotorGlyphSide }
> = {
  FRONT_RIGHT: { row: 'FRONT', side: 'RIGHT' },
  FRONT_LEFT: { row: 'FRONT', side: 'LEFT' },
  REAR_RIGHT: { row: 'REAR', side: 'RIGHT' },
  REAR_LEFT: { row: 'REAR', side: 'LEFT' },
};

/**
 * The tested label geometry used by both the rendered diagram and the
 * payload-identity suite. It derives from the accepted configuration and
 * the same visual order as the component; there is no second slot mapping.
 */
export function computeMotorGlyphLayout(): readonly MotorGlyphCell[] {
  const entries = orderAirframeEntries(
    MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry => ({
      slot: entry.motorNumber,
      position: entry.position,
      direction: entry.direction,
    })),
  );
  return Object.freeze(
    entries.map(entry => {
      const geometry = POSITION_GEOMETRY[entry.position];
      return Object.freeze({
        slot: entry.slot,
        row: geometry.row,
        side: geometry.side,
        positionKey: positionKey(entry.position),
        directionKey: directionKey(entry.direction),
      });
    }),
  );
}

export function motorGlyphRows(): readonly (readonly MotorGlyphCell[])[] {
  const cells = computeMotorGlyphLayout();
  return Object.freeze([
    cells.filter(cell => cell.row === 'FRONT'),
    cells.filter(cell => cell.row === 'REAR'),
  ]);
}

function positionKey(position: MotorPhysicalPosition): string {
  switch (position) {
    case 'FRONT_LEFT':
      return 'positionFrontLeft';
    case 'FRONT_RIGHT':
      return 'positionFrontRight';
    case 'REAR_LEFT':
      return 'positionRearLeft';
    case 'REAR_RIGHT':
      return 'positionRearRight';
  }
}

function directionKey(direction: MotorRotationDirection): string {
  return direction === 'CW' ? 'directionCw' : 'directionCcw';
}

function activityLabelKey(activity: MotorSlotActivity): string {
  switch (activity) {
    case 'SUBMITTED':
      return 'motorsScreen.slotStateSubmitted';
    case 'ACKNOWLEDGED':
      return 'motorsScreen.slotStateAcknowledged';
    case 'STOPPING':
      return 'motorsScreen.slotStateStopping';
    case 'UNSAFE':
      return 'motorsScreen.slotStateUnsafe';
  }
}

function activityColor(activity: MotorSlotActivity): string {
  switch (activity) {
    case 'SUBMITTED':
    case 'ACKNOWLEDGED':
      return colors.warning;
    case 'STOPPING':
      return colors.info;
    case 'UNSAFE':
      return colors.error;
  }
}

function cellTestId(position: MotorPhysicalPosition): string {
  return `motors-diagram-cell-${position.replace('_', '-')}`;
}

/**
 * A hub, two blades and a LARGE curved rotation arrow whose direction is
 * also written out (CW / CCW), so the arrow is never the only carrier of
 * meaning.
 */
function RotorGlyph({
  direction,
  scale,
  active,
}: {
  direction: MotorRotationDirection;
  scale: number;
  active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const size = Math.round(30 * scale);
  const bladeLength = Math.round(size * 0.86);
  const bladeThickness = Math.max(3, Math.round(size * 0.13));
  const hub = Math.max(6, Math.round(size * 0.26));
  const arrowFont = Math.max(14, Math.round(size * 0.62));
  return (
    <View style={styles.rotorWrap}>
      <View
        style={[
          styles.rotor,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: Math.max(1, Math.round(size * 0.06)),
          },
          active && styles.rotorActive,
        ]}
      >
        <View
          style={[
            styles.blade,
            {
              width: bladeLength,
              height: bladeThickness,
              transform: [{ rotate: '32deg' }],
            },
          ]}
        />
        <View
          style={[
            styles.blade,
            {
              width: bladeLength,
              height: bladeThickness,
              transform: [{ rotate: '-32deg' }],
            },
          ]}
        />
        <View
          style={[styles.hub, { width: hub, height: hub, borderRadius: hub / 2 }]}
        />
        <Text
          style={[
            styles.rotationArrow,
            { fontSize: arrowFont, lineHeight: Math.round(arrowFont * 1.1) },
            active && styles.rotationArrowActive,
          ]}
        >
          {direction === 'CW' ? '↻' : '↺'}
        </Text>
      </View>
      <Text
        style={[
          styles.directionText,
          { fontSize: Math.max(9, Math.round(11 * scale)) },
        ]}
        testID={`motors-diagram-direction-${direction}`}
      >
        {t(
          direction === 'CW'
            ? 'motorsScreen.diagramCw'
            : 'motorsScreen.diagramCcw',
        )}
      </Text>
    </View>
  );
}

function MotorNode({
  entry,
  selected,
  activity,
  verified,
  scale,
  onSelect,
}: {
  entry: MotorAirframeEntry;
  selected: boolean;
  activity: MotorSlotActivity | undefined;
  verified: boolean;
  scale: number;
  onSelect: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const slotFont = Math.max(13, Math.round(18 * scale));
  const positionFont = Math.max(9, Math.round(11 * scale));
  const badge =
    activity !== undefined
      ? { text: t(activityLabelKey(activity)), color: activityColor(activity) }
      : verified
      ? { text: t('motorsScreen.slotStateObserved'), color: colors.success }
      : selected
      ? { text: t('motorsScreen.slotStateSelected'), color: colors.accentStrong }
      : undefined;

  return (
    <View style={styles.motorCell} testID={cellTestId(entry.position)}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={`${`M${entry.slot}`}، ${t(
          `motorsScreen.${positionKey(entry.position)}`,
        )}، ${t(`motorsScreen.${directionKey(entry.direction)}`)}${
          badge !== undefined ? `، ${badge.text}` : ''
        }`}
        style={[
          styles.motorNode,
          { padding: Math.round(6 * scale), gap: Math.round(3 * scale) },
          selected && styles.motorNodeSelected,
          verified && styles.motorNodeVerified,
          activity !== undefined && {
            borderColor: activityColor(activity),
            borderWidth: 2,
          },
        ]}
        testID={`motors-airframe-slot-${entry.slot}`}
      >
        <RotorGlyph
          direction={entry.direction}
          scale={scale}
          active={activity !== undefined}
        />
        <Text
          style={[styles.slot, { fontSize: slotFont, lineHeight: slotFont + 2 }]}
          testID={`motors-diagram-slot-${entry.slot}`}
        >
          {`M${entry.slot}`}
        </Text>
        <Text
          style={[
            styles.position,
            { fontSize: positionFont, lineHeight: positionFont + 3 },
          ]}
          numberOfLines={1}
        >
          {t(`motorsScreen.${positionKey(entry.position)}`)}
        </Text>
        {badge !== undefined ? (
          <View
            style={[styles.stateBadge, { borderColor: badge.color }]}
            testID={`motors-diagram-state-${entry.slot}`}
          >
            <Text
              style={[
                styles.stateBadgeText,
                { color: badge.color, fontSize: positionFont },
              ]}
            >
              {badge.text}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

export function MotorAirframeDiagram({
  entries,
  selectedSlot,
  liveSlot,
  liveActivity,
  verifiedSlots = [],
  onSelectSlot,
}: MotorAirframeDiagramProps): React.JSX.Element {
  const { t } = useTranslation();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const stageWidth = computeAirframeStageWidth(windowWidth, fontScale);
  // Every internal dimension is a multiple of this, so the whole diagram
  // grows as one drawing instead of a big box around small glyphs.
  const scale = stageWidth / 260;

  const ordered = orderAirframeEntries(entries);
  const front = ordered.slice(0, 2);
  const rear = ordered.slice(2, 4);

  const renderNode = (entry: MotorAirframeEntry) => (
    <MotorNode
      key={entry.slot}
      entry={entry}
      selected={entry.slot === selectedSlot}
      activity={entry.slot === liveSlot ? liveActivity : undefined}
      verified={verifiedSlots.includes(entry.slot)}
      scale={scale}
      onSelect={() => onSelectSlot(entry.slot)}
    />
  );

  const armThickness = Math.max(6, Math.round(stageWidth * 0.045));

  return (
    <View style={styles.root} testID="motors-airframe-diagram">
      <Text style={styles.diagramTitle}>{t('motorsScreen.diagramTitle')}</Text>

      <View style={styles.frontMarker} testID="motors-diagram-front">
        <Text
          style={[
            styles.frontArrow,
            {
              fontSize: Math.round(22 * scale),
              lineHeight: Math.round(24 * scale),
            },
          ]}
        >
          ▲
        </Text>
        <Text
          style={[
            styles.frontText,
            { fontSize: Math.max(12, Math.round(15 * scale)) },
          ]}
        >
          {t('motorsScreen.diagramFront')}
        </Text>
      </View>

      <View
        style={[styles.stage, { width: stageWidth, height: stageWidth }]}
        testID="motors-airframe-stage"
      >
        <View
          style={[
            styles.arm,
            { height: armThickness, marginTop: -armThickness / 2 },
            styles.armForward,
          ]}
        />
        <View
          style={[
            styles.arm,
            { height: armThickness, marginTop: -armThickness / 2 },
            styles.armBackward,
          ]}
        />
        <View style={styles.body}>
          <View
            style={[
              styles.bodyNose,
              {
                top: -Math.round(12 * scale),
                borderLeftWidth: Math.round(10 * scale),
                borderRightWidth: Math.round(10 * scale),
                borderBottomWidth: Math.round(14 * scale),
              },
            ]}
          />
          <View style={styles.bodyPlate} />
          <View style={styles.bodyCore} />
          <View style={styles.tailMark} />
        </View>

        <View style={[styles.motorRow, styles.frontRow]}>
          {front.map(renderNode)}
        </View>
        <View style={[styles.motorRow, styles.rearRow]}>
          {rear.map(renderNode)}
        </View>
      </View>

      <Text style={styles.caption}>{t('motorsScreen.diagramCaption')}</Text>

      <View style={styles.legend} testID="motors-diagram-legend">
        <LegendItem
          color={colors.accent}
          label={t('motorsScreen.legendSelected')}
        />
        <LegendItem
          color={colors.warning}
          label={t('motorsScreen.legendSubmitted')}
        />
        <LegendItem
          color={colors.warning}
          label={t('motorsScreen.legendAcknowledged')}
        />
        <LegendItem
          color={colors.info}
          label={t('motorsScreen.legendStopping')}
        />
        <LegendItem
          color={colors.success}
          label={t('motorsScreen.legendObserved')}
        />
        <LegendItem
          color={colors.error}
          label={t('motorsScreen.legendUnsafe')}
        />
      </View>
    </View>
  );
}

function LegendItem({
  color,
  label,
}: {
  color: string;
  label: string;
}): React.JSX.Element {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, alignItems: 'center' },
  diagramTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  frontMarker: { alignItems: 'center', gap: 1 },
  frontArrow: { color: colors.accentStrong, fontWeight: '900' },
  frontText: {
    color: colors.accentStrong,
    fontWeight: '800',
    writingDirection: 'rtl',
  },
  stage: {
    alignSelf: 'center',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#F7FAF9',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  arm: {
    position: 'absolute',
    left: '12%',
    top: '50%',
    width: '76%',
    borderRadius: radii.pill,
    backgroundColor: '#BBD8D4',
    borderColor: colors.border,
    borderWidth: 1,
  },
  armForward: { transform: [{ rotate: '45deg' }] },
  armBackward: { transform: [{ rotate: '-45deg' }] },
  body: {
    position: 'absolute',
    left: '36%',
    top: '36%',
    width: '28%',
    height: '28%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderColor: colors.accent,
    borderWidth: 1,
    backgroundColor: '#D9EFEB',
  },
  bodyNose: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.accent,
  },
  bodyPlate: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '16%',
    bottom: '14%',
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  bodyCore: {
    width: '40%',
    height: '44%',
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentStrong,
    borderWidth: 1,
  },
  tailMark: {
    position: 'absolute',
    bottom: 3,
    width: '30%',
    height: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted,
  },
  motorRow: {
    position: 'absolute',
    left: '2%',
    right: '2%',
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
  },
  frontRow: { top: '2%' },
  rearRow: { bottom: '2%' },
  motorCell: { alignItems: 'center' },
  motorNode: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  motorNodeSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  motorNodeVerified: { borderColor: colors.success },
  rotorWrap: { alignItems: 'center', gap: 1 },
  rotor: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.textSecondary,
    backgroundColor: colors.backgroundRaised,
  },
  rotorActive: { borderColor: colors.warning, backgroundColor: '#FFF4D8' },
  blade: {
    position: 'absolute',
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted,
  },
  hub: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.background,
    borderWidth: 1,
  },
  rotationArrow: {
    position: 'absolute',
    color: colors.accentStrong,
    fontWeight: '900',
  },
  rotationArrowActive: { color: colors.warning },
  directionText: {
    ...typography.mono,
    color: colors.accentStrong,
    fontWeight: '800',
    writingDirection: 'ltr',
  },
  slot: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '900',
    writingDirection: 'ltr',
  },
  position: {
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  stateBadge: {
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    backgroundColor: colors.background,
  },
  stateBadgeText: { fontWeight: '800', writingDirection: 'rtl' },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
    maxWidth: 460,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
});
