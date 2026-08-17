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
import { colors, radii, spacing, typography, fonts} from '../theme';
import { Icon } from '../icons';
import { isRtlLayout } from '../icons/layoutDirection';
import { resolveLayoutTier } from '../theme/layout';

export interface MotorAirframeEntry {
  readonly slot: number;
  readonly position: MotorPhysicalPosition;
  /**
   * UNDEFINED MEANS UNKNOWN, AND UNKNOWN IS RENDERED AS UNKNOWN.
   *
   * There is no MSP field at API 1.47 that reports which way a motor
   * actually spins - `motorsScreen.diagramDirectionSource` has said so in
   * Arabic since P3, and auditing the pinned firmware again for this pass
   * did not turn one up. What the screen supplies today is therefore the
   * EXPECTED Quad-X reference, not a measurement.
   *
   * This field exists so that distinction is structural rather than a
   * caption: a caller with no direction truth passes undefined and gets an
   * explicit unknown mark, never a confident arrow pointing the wrong way.
   */
  readonly direction?: MotorRotationDirection;
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
  /**
   * The REAL output count from the flight controller.
   *
   * PART Q, and an honesty problem rather than a layout one. This file has
   * authoritative geometry for exactly one airframe: Quad X. It was being
   * rendered unconditionally, so a hex or octo build was shown a
   * four-motor aircraft with M1-M4 on it - measured on the `motors-p3-hex`
   * scene, which produced an identical quad at all three widths. Outputs
   * 5-8 simply were not on the drawing, and the four that were carried
   * positions the frame does not have.
   *
   * Inventing arm angles for a frame this app cannot identify would be
   * worse. Any count other than four therefore gets a numbered output list
   * that claims no geometry at all, and says so.
   */
  readonly motorCount?: number;
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
        // computeMotorGlyphLayout builds from MOTOR_TEST_EXPECTED_CONFIGURATION,
        // where every entry carries a direction. An unknown-direction entry
        // reaches the RENDERED diagram, never this identity helper.
        directionKey:
          entry.direction === undefined
            ? 'directionUnknown'
            : directionKey(entry.direction),
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
 * ONE motor: a disc with two blades and a hub, and ONE rotation arrow
 * placed on a ring OUTSIDE that disc.
 *
 * WHAT WAS WRONG, measured at 390px before this pass. The arrow was an
 * icon rendered INSIDE the 30px rotor circle, on top of the blades and the
 * hub, at roughly 19px - three glyphs stacked in the same 30px box. The
 * operator reported it as "arrows overlap" and "arrows can appear
 * distorted", which is exactly what a rotation arrow drawn over a
 * two-bladed propeller looks like. The CW/CCW text sat directly beneath,
 * making the node tall enough to collide with the node in the other row.
 *
 * NOW: the disc keeps the blades, the arrow gets its own radius outside
 * it, and the CW/CCW token moves up beside the M-number where it reads as
 * a label rather than a caption. Nothing is stacked on anything.
 *
 * MEANING IS NEVER THE ARROW ALONE - the written CW / CCW / ؟ token in the
 * label row carries the same fact for anyone the arrow does not reach.
 */
function RotorGlyph({
  direction,
  scale,
  active,
}: {
  direction: MotorRotationDirection | undefined;
  scale: number;
  active: boolean;
}): React.JSX.Element {
  const size = Math.round(30 * scale);
  const bladeLength = Math.round(size * 0.86);
  const bladeThickness = Math.max(3, Math.round(size * 0.13));
  const hub = Math.max(6, Math.round(size * 0.26));
  /** The arrow's own ring. 1.55x the disc keeps a real gap at every tier. */
  const ring = Math.round(size * 1.55);
  const arrow = Math.max(15, Math.round(size * 0.55));
  return (
    <View style={[styles.rotorRing, { width: ring, height: ring }]}>
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
            { width: bladeLength, height: bladeThickness, transform: [{ rotate: '32deg' }] },
          ]}
        />
        <View
          style={[
            styles.blade,
            { width: bladeLength, height: bladeThickness, transform: [{ rotate: '-32deg' }] },
          ]}
        />
        <View
          style={[styles.hub, { width: hub, height: hub, borderRadius: hub / 2 }]}
        />
      </View>
      {direction !== undefined ? (
        <Icon
          // Absolutely positioned on the ring, clear of the disc entirely.
          name={direction === 'CW' ? 'rotate-cw' : 'rotate-ccw'}
          size={arrow}
          color={active ? colors.warning : colors.accentStrong}
          strokeWidth={2.5}
        />
      ) : (
        <Icon
          name="circle-question-mark"
          size={arrow}
          color={colors.textMuted}
          strokeWidth={2.5}
        />
      )}
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
  const slotFont = Math.max(14, Math.round(17 * scale));
  const tokenFont = Math.max(11, Math.round(12 * scale));
  const badge =
    activity !== undefined
      ? { text: t(activityLabelKey(activity)), color: activityColor(activity) }
      : verified
      ? { text: t('motorsScreen.slotStateObserved'), color: colors.success }
      : selected
      ? { text: t('motorsScreen.slotStateSelected'), color: colors.accentStrong }
      : undefined;
  const directionToken =
    entry.direction === undefined
      ? t('motorsScreen.directionUnknownShort')
      : t(
          entry.direction === 'CW'
            ? 'motorsScreen.diagramCw'
            : 'motorsScreen.diagramCcw',
        );
  const directionSpoken =
    entry.direction === undefined
      ? t('motorsScreen.directionUnknown')
      : t(`motorsScreen.${directionKey(entry.direction)}`);

  return (
    <View style={styles.motorCell} testID={cellTestId(entry.position)}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        // The position IS spoken, even though it left the visible node: a
        // screen-reader user cannot see where the mark sits on the frame.
        accessibilityLabel={`${`M${entry.slot}`}، ${t(
          `motorsScreen.${positionKey(entry.position)}`,
        )}، ${directionSpoken}${badge !== undefined ? `، ${badge.text}` : ''}`}
        style={[
          styles.motorNode,
          { padding: Math.round(5 * scale) },
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
        {/* ONE label row: the M-number and the direction token side by
            side. The Arabic position phrase that used to sit here is gone
            - it was the widest and tallest thing in the node, it repeated
            what the node's own place on the frame already says, and it is
            still spoken by the accessibility label above. */}
        <View style={styles.labelRow}>
          <Text
            style={[styles.slot, { fontSize: slotFont, lineHeight: slotFont + 2 }]}
            testID={`motors-diagram-slot-${entry.slot}`}
          >
            {`M${entry.slot}`}
          </Text>
          <Text
            style={[
              styles.directionText,
              { fontSize: tokenFont, lineHeight: tokenFont + 3 },
            ]}
            testID={`motors-diagram-direction-${entry.slot}`}
          >
            {directionToken}
          </Text>
        </View>
        {/* A RESERVED badge row, always present.
            Measured before this pass: the selected node grew from 95px to
            124px at 390px because the badge appeared inside it, and the
            two rows then overlapped by 19.31px - an overlap that came and
            went as the operator selected different motors. A fixed slot
            makes every node the same height in every state. */}
        <View
          style={[
            styles.badgeSlot,
            { height: Math.max(16, Math.round(18 * scale)) },
          ]}
        >
          {badge !== undefined ? (
            <View
              style={[styles.stateBadge, { borderColor: badge.color }]}
              testID={`motors-diagram-state-${entry.slot}`}
            >
              <Text
                style={[
                  styles.stateBadgeText,
                  { color: badge.color, fontSize: tokenFont },
                ]}
                numberOfLines={1}
              >
                {badge.text}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

/** The one airframe this file can draw truthfully. */
export const MOTOR_AIRFRAME_QUAD_COUNT = 4;

/**
 * The honest fallback: numbered outputs, no aircraft, no claimed
 * positions, no rotation arrows. It says what it is in the caption.
 */
function GenericMotorOutputs({
  motorCount,
  selectedSlot,
  liveSlot,
  liveActivity,
  verifiedSlots,
  onSelectSlot,
}: {
  motorCount: number;
  selectedSlot: number;
  liveSlot?: number;
  liveActivity?: MotorSlotActivity;
  verifiedSlots: readonly number[];
  onSelectSlot: (slot: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <View style={styles.root} testID="motors-generic-outputs">
      <Text style={styles.diagramTitle}>
        {t('motorsScreen.layoutGenericHeading')}
      </Text>
      <View style={styles.genericGrid}>
        {Array.from({ length: motorCount }, (_, index) => {
          const slot = index + 1;
          const activity = slot === liveSlot ? liveActivity : undefined;
          const verified = verifiedSlots.includes(slot);
          const badge =
            activity !== undefined
              ? { text: t(activityLabelKey(activity)), color: activityColor(activity) }
              : verified
              ? { text: t('motorsScreen.slotStateObserved'), color: colors.success }
              : slot === selectedSlot
              ? { text: t('motorsScreen.slotStateSelected'), color: colors.accentStrong }
              : undefined;
          return (
            <Pressable
              key={slot}
              onPress={() => onSelectSlot(slot)}
              accessibilityRole="radio"
              accessibilityState={{ selected: slot === selectedSlot }}
              accessibilityLabel={`M${slot}${
                badge !== undefined ? `، ${badge.text}` : ''
              }`}
              style={[
                styles.genericCell,
                slot === selectedSlot && styles.motorNodeSelected,
                verified && styles.motorNodeVerified,
                // Only the COLOUR is dynamic; the weight is a constant and
                // belongs in the stylesheet, not inline.
                activity !== undefined && styles.genericCellActive,
                activity !== undefined && { borderColor: activityColor(activity) },
              ]}
              testID={`motors-generic-slot-${slot}`}
            >
              <Text style={styles.genericSlotText}>{`M${slot}`}</Text>
              {badge !== undefined ? (
                <Text
                  style={[styles.genericBadgeText, { color: badge.color }]}
                  numberOfLines={1}
                >
                  {badge.text}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.caption} testID="motors-generic-outputs-caption">
        {t('motorsScreen.layoutGenericCaption')}
      </Text>
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
  motorCount = MOTOR_AIRFRAME_QUAD_COUNT,
}: MotorAirframeDiagramProps): React.JSX.Element {
  const { t } = useTranslation();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const stageWidth = computeAirframeStageWidth(windowWidth, fontScale);
  // Every internal dimension is a multiple of this, so the whole diagram
  // grows as one drawing instead of a big box around small glyphs.
  const scale = stageWidth / 260;

  if (motorCount !== MOTOR_AIRFRAME_QUAD_COUNT) {
    return (
      <GenericMotorOutputs
        motorCount={motorCount}
        selectedSlot={selectedSlot}
        liveSlot={liveSlot}
        liveActivity={liveActivity}
        verifiedSlots={verifiedSlots}
        onSelectSlot={onSelectSlot}
      />
    );
  }

  const ordered = orderAirframeEntries(entries);
  /**
   * PHYSICAL PLACEMENT, COMPUTED - not delegated to a style property.
   *
   * orderAirframeEntries emits RIGHT-then-LEFT (its own contract, tested,
   * untouched). A plain flex row paints index 0 at the reading-start
   * edge: the RIGHT edge under RTL, the LEFT edge under LTR. So the
   * paint order is simply reversed for LTR, and FRONT_RIGHT lands on the
   * operator's right either way.
   *
   * WHY NOT `direction: 'ltr'` + row-reverse, which this file tried
   * first: react-native-web SILENTLY DROPS the React Native `direction`
   * style. Measured in a real browser - the rendered row still computed
   * `direction: rtl`, row-reverse inverted it, and the aircraft was drawn
   * MIRRORED (M2 "أمامي يمين" appeared on the left). A style the platform
   * ignores cannot carry a safety guarantee, and a unit test that asserts
   * the style OBJECT rather than the rendered box will not catch it.
   *
   * This changes no motor data: same entries, same slots, same mapping.
   */
  const paintOrder = (pair: readonly MotorAirframeEntry[]) =>
    isRtlLayout() ? pair : [...pair].reverse();
  const front = paintOrder(ordered.slice(0, 2));
  const rear = paintOrder(ordered.slice(2, 4));

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
        <Icon
          name="chevron-up"
          size={Math.round(22 * scale)}
          color={colors.accentStrong}
          strokeWidth={2.5}
        />
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
  frontText: {
    // fontFamily is explicit because the SIZE is applied inline at render
    // time; spreading a token would be overridden, and omitting the family
    // dropped this label to the system font (measured in a browser).
    fontFamily: fonts.family,
    color: colors.accentStrong,
    fontWeight: '700',
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
    /* PART M - BREATHING ROOM, sized from the measurement rather than
       guessed. Pulling the rows in from 2% to 6% moves each node ~8px off
       the stage edge at 390px and, with the node now ~40px shorter and
       height-stable, leaves a real gap between the front and rear rows
       instead of the measured 19.31px overlap. */
    left: '6%',
    right: '6%',
    /**
     * A plain row. The PHYSICAL placement is decided in the component
     * (see paintOrder), not by this style: react-native-web drops the
     * React Native `direction` property, so no style here can pin the
     * aircraft's left and right.
     */
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  frontRow: { top: '3%' },
  rearRow: { bottom: '3%' },
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
  /* The arrow's own radius. `justifyContent: flex-start` puts the arrow at
     the top of the ring and the disc is centred inside by the absolute
     rule below, so the two never share pixels. */
  rotorRing: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    /* A technical row: M-number then CW/CCW, in that order, in every
       locale. Physical identity is not a reading direction. */
    direction: 'ltr',
  },
  /* Reserved whether or not a badge exists - see MotorNode. */
  badgeSlot: { justifyContent: 'center', alignItems: 'center' },
  motorNodeSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  motorNodeVerified: { borderColor: colors.success },
  rotor: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.textSecondary,
    backgroundColor: colors.backgroundRaised,
  },
  rotorActive: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
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
  directionText: {
    /* MONO on purpose: CW/CCW is a technical identifier, not prose. */
    ...typography.mono,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  slot: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  position: {
    // Arabic prose ("أمامي يمين"), sized inline - so the family must be
    // named here or it falls back to the system font.
    fontFamily: fonts.family,
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
  stateBadgeText: {
    fontFamily: fonts.family,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
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
  genericGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  genericCellActive: { borderWidth: 2 },
  genericSlotText: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
    fontSize: 16,
    lineHeight: 20,
  },
  genericBadgeText: {
    fontFamily: fonts.family,
    fontWeight: '700',
    writingDirection: 'rtl',
    fontSize: 11,
  },
  genericCell: {
    minWidth: 64,
    minHeight: 56,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
});
