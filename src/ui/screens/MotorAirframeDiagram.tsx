/**
 * Purpose-built Quad X airframe reference for the Motors workspace.
 *
 * It is intentionally a view-only geometry layer: the slot passed to
 * onSelectSlot is the same slot printed on the node, while direction and
 * position remain explicitly labelled as an expected reference. No value
 * from this component can reach a motor command or alter a safety gate.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type {
  MotorPhysicalPosition,
  MotorRotationDirection,
} from '../../core/state/motorVerificationModel';
import { MOTOR_TEST_EXPECTED_CONFIGURATION } from '../../core/state/motorVerificationModel';
import { colors, radii, spacing, typography } from '../theme';

export interface MotorAirframeEntry {
  readonly slot: number;
  readonly position: MotorPhysicalPosition;
  readonly direction: MotorRotationDirection;
}

export interface MotorAirframeDiagramProps {
  readonly entries: readonly MotorAirframeEntry[];
  readonly selectedSlot: number;
  readonly liveSlot?: number;
  readonly verifiedSlots?: readonly number[];
  readonly onSelectSlot: (slot: number) => void;
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

function cellTestId(position: MotorPhysicalPosition): string {
  return `motors-diagram-cell-${position.replace('_', '-')}`;
}

function RotorGlyph({
  direction,
  live,
}: {
  direction: MotorRotationDirection;
  live: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.rotor, live && styles.rotorLive]}>
      <View style={[styles.blade, styles.bladeA]} />
      <View style={[styles.blade, styles.bladeB]} />
      <View style={styles.hub} />
      <View style={[styles.directionBadge, live && styles.directionBadgeLive]}>
        <Text style={styles.directionSymbol}>
          {direction === 'CW' ? '↻' : '↺'}
        </Text>
      </View>
    </View>
  );
}

function MotorNode({
  entry,
  selected,
  live,
  verified,
  onSelect,
}: {
  entry: MotorAirframeEntry;
  selected: boolean;
  live: boolean;
  verified: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <View style={styles.motorCell} testID={cellTestId(entry.position)}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={`${`M${entry.slot}`}، ${t(
          `motorsScreen.${positionKey(entry.position)}`,
        )}، ${t(`motorsScreen.${directionKey(entry.direction)}`)}`}
        style={[
          styles.motorNode,
          selected && styles.motorNodeSelected,
          verified && styles.motorNodeVerified,
          live && styles.motorNodeLive,
        ]}
        testID={`motors-airframe-slot-${entry.slot}`}
      >
        <RotorGlyph direction={entry.direction} live={live} />
        <View style={styles.nodeCopy}>
          <View style={styles.slotLine}>
            <Text
              style={[styles.slot, live && styles.slotLive]}
              testID={`motors-diagram-slot-${entry.slot}`}
            >
              {`M${entry.slot}`}
            </Text>
            {verified ? <Text style={styles.verifiedMark}>✓</Text> : null}
          </View>
          <Text style={styles.position} numberOfLines={1}>
            {t(`motorsScreen.${positionKey(entry.position)}`)}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

export function MotorAirframeDiagram({
  entries,
  selectedSlot,
  liveSlot,
  verifiedSlots = [],
  onSelectSlot,
}: MotorAirframeDiagramProps): React.JSX.Element {
  const { t } = useTranslation();
  const ordered = orderAirframeEntries(entries);
  const front = ordered.slice(0, 2);
  const rear = ordered.slice(2, 4);

  const renderNode = (entry: MotorAirframeEntry) => (
    <MotorNode
      key={entry.slot}
      entry={entry}
      selected={entry.slot === selectedSlot}
      live={entry.slot === liveSlot}
      verified={verifiedSlots.includes(entry.slot)}
      onSelect={() => onSelectSlot(entry.slot)}
    />
  );

  return (
    <View style={styles.root} testID="motors-airframe-diagram">
      <View style={styles.frontMarker} testID="motors-diagram-front">
        <Text style={styles.frontArrow}>▲</Text>
        <Text style={styles.frontText}>{t('motorsScreen.diagramFront')}</Text>
      </View>

      <View style={styles.stage}>
        <View style={[styles.arm, styles.armForward]} />
        <View style={[styles.arm, styles.armBackward]} />
        <View style={styles.bodyShadow} />
        <View style={styles.body}>
          <View style={styles.bodyNose} />
          <View style={styles.bodyCore} />
          <Text style={styles.bodyLabel}>FPV</Text>
        </View>

        <View style={[styles.motorRow, styles.frontRow]}>
          {front.map(renderNode)}
        </View>
        <View style={[styles.motorRow, styles.rearRow]}>
          {rear.map(renderNode)}
        </View>
      </View>

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.legendSelected]} />
          <Text style={styles.legendText}>
            {t('motorsScreen.legendSelected')}
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.legendLive]} />
          <Text style={styles.legendText}>{t('motorsScreen.legendLive')}</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, styles.legendVerified]} />
          <Text style={styles.legendText}>
            {t('motorsScreen.legendObserved')}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  frontMarker: { alignItems: 'center', gap: 2 },
  frontArrow: { fontSize: 20, lineHeight: 22, color: colors.accent },
  frontText: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  stage: {
    width: '100%',
    maxWidth: 390,
    aspectRatio: 1.12,
    alignSelf: 'center',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#091D26',
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  arm: {
    position: 'absolute',
    left: '14%',
    top: '48%',
    width: '72%',
    height: 12,
    marginTop: -6,
    borderRadius: radii.pill,
    backgroundColor: '#2B5864',
    borderColor: colors.border,
    borderWidth: 1,
  },
  armForward: { transform: [{ rotate: '38deg' }] },
  armBackward: { transform: [{ rotate: '-38deg' }] },
  bodyShadow: {
    position: 'absolute',
    left: '39%',
    top: '35%',
    width: '22%',
    height: '32%',
    borderRadius: radii.lg,
    backgroundColor: colors.shadow,
    opacity: 0.5,
    transform: [{ translateY: 5 }],
  },
  body: {
    position: 'absolute',
    left: '39%',
    top: '34%',
    width: '22%',
    height: '32%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.lg,
    borderColor: colors.accent,
    borderWidth: 1,
    backgroundColor: colors.surfaceRaised,
  },
  bodyNose: {
    position: 'absolute',
    top: -10,
    width: 0,
    height: 0,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderBottomWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.accent,
  },
  bodyCore: {
    width: 22,
    height: 34,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  bodyLabel: {
    ...typography.eyebrow,
    position: 'absolute',
    bottom: spacing.xs,
    color: colors.textMuted,
    writingDirection: 'ltr',
  },
  motorRow: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    direction: 'rtl',
    justifyContent: 'space-between',
  },
  frontRow: { top: spacing.sm },
  rearRow: { bottom: spacing.sm },
  motorCell: {
    width: '34%',
    minWidth: 104,
    maxWidth: 124,
  },
  motorNode: {
    width: '100%',
    minHeight: 106,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: '#0D2934',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.xs,
  },
  motorNodeSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  motorNodeVerified: { borderColor: colors.success },
  motorNodeLive: {
    borderColor: colors.warning,
    borderWidth: 2,
    backgroundColor: '#342A17',
    elevation: 4,
  },
  rotor: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.textSecondary,
    borderWidth: 2,
    backgroundColor: colors.backgroundRaised,
  },
  rotorLive: { borderColor: colors.warning, backgroundColor: '#3B2C12' },
  blade: {
    position: 'absolute',
    width: 45,
    height: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted,
  },
  bladeA: { transform: [{ rotate: '32deg' }] },
  bladeB: { transform: [{ rotate: '-32deg' }] },
  hub: {
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: colors.textPrimary,
    borderColor: colors.background,
    borderWidth: 2,
  },
  directionBadge: {
    position: 'absolute',
    right: -9,
    bottom: -7,
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  directionBadgeLive: { borderColor: colors.warning },
  directionSymbol: { fontSize: 18, lineHeight: 21, color: colors.accent },
  nodeCopy: { alignItems: 'center', gap: 1 },
  slotLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  slot: {
    ...typography.mono,
    color: colors.textPrimary,
    fontWeight: '800',
    writingDirection: 'ltr',
  },
  slotLive: { color: colors.warning },
  verifiedMark: { color: colors.success, fontWeight: '900' },
  position: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendSelected: { backgroundColor: colors.accent },
  legendLive: { backgroundColor: colors.warning },
  legendVerified: { backgroundColor: colors.success },
  legendText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
});
