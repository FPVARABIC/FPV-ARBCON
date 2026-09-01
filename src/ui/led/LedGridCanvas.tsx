/**
 * THE PHYSICAL GRID - 16x16, AND THE LAYOUT DIRECTION NEVER TOUCHES IT.
 *
 * X=0 IS THE LEFT EDGE OF THE AIRCRAFT AND Y=0 IS ITS NOSE, in every
 * locale, on every platform. This is not a text layout; it is a diagram of
 * where the operator physically stuck the LEDs, and mirroring it would
 * turn "front-left" into "front-right" on a machine that is about to fly.
 *
 * HOW THAT IS GUARANTEED, rather than hoped for: this file never calls
 * `isRtlLayout()`, never uses `flexDirection`, and never uses the logical
 * `start`/`end` insets. Every cell is placed with absolute `left` and
 * `top`, which React Native and react-native-web both treat as physical
 * and neither mirrors. A test renders the same strip under RTL and under
 * LTR and compares the numbers.
 *
 * THE GRID IS A SYMBOLIC LAYOUT, NOT A LIVE VIEW. The board reports no LED
 * output over MSP - there is nothing to mirror and no telemetry to poll -
 * so nothing here animates, blinks, sweeps or rotates. A cell shows the
 * colour slot an LED is CONFIGURED to start from; what the aircraft
 * actually emits is the product of ten timed layers this app cannot see.
 */

import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {colors, radii, spacing, typography} from '../theme';
import {Icon} from '../icons';
import {
  ledColorIsOff,
  ledColorToCss,
  ledSwatchInk,
  type LedColorTriplet,
} from './ledColorPresentation';
import type {LedDraftNode} from '../../core/state/ledStripDraft';

/** The touch target, and the reason the canvas is 704 units wide. Below
 *  44 a fingertip cannot reliably pick one cell out of sixteen. */
export const LED_CELL_SIZE = 44;
export const LED_GRID_SPAN = 16;
export const LED_GRID_EXTENT = LED_CELL_SIZE * LED_GRID_SPAN;
/** Inset inside the pitch, so cells read as separate without moving. */
const CELL_INSET = 3;

export interface LedGridCanvasProps {
  readonly nodes: readonly LedDraftNode[];
  /** Physical indexes sharing each `x:y`, so a shared cell can say so. */
  readonly clusters: ReadonlyMap<string, readonly number[]>;
  readonly selection: readonly number[];
  readonly palette: readonly LedColorTriplet[] | undefined;
  /** A cell that holds at least one LED. */
  readonly onSelectCell: (x: number, y: number) => void;
  /** A cell that holds none. */
  readonly onEmptyCell: (x: number, y: number) => void;
  readonly frontLabel: string;
  readonly rearLabel: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  /** Announced per cell, already interpolated. */
  readonly describeCell: (x: number, y: number, indexes: readonly number[]) => string;
  readonly disabled?: boolean;
}

/** Exported so the geometry test can assert the arithmetic directly rather
 *  than scraping it back out of a rendered tree. */
export function ledCellLeft(x: number): number {
  return x * LED_CELL_SIZE;
}

export function ledCellTop(y: number): number {
  return y * LED_CELL_SIZE;
}

export const ledCellKey = (x: number, y: number): string => `${x}:${y}`;

export function LedGridCanvas({
  nodes,
  clusters,
  selection,
  palette,
  onSelectCell,
  onEmptyCell,
  frontLabel,
  rearLabel,
  leftLabel,
  rightLabel,
  describeCell,
  disabled = false,
}: LedGridCanvasProps): React.JSX.Element {
  const selected = React.useMemo(() => new Set(selection), [selection]);
  const byCell = React.useMemo(() => {
    const map = new Map<string, LedDraftNode[]>();
    for (const node of nodes) {
      const key = ledCellKey(node.x, node.y);
      const bucket = map.get(key);
      if (bucket === undefined) map.set(key, [node]);
      else bucket.push(node);
    }
    return map;
  }, [nodes]);

  const cells: React.JSX.Element[] = [];
  for (let y = 0; y < LED_GRID_SPAN; y++) {
    for (let x = 0; x < LED_GRID_SPAN; x++) {
      const key = ledCellKey(x, y);
      const occupants = byCell.get(key) ?? [];
      cells.push(
        <LedCell
          key={key}
          x={x}
          y={y}
          occupants={occupants}
          clusterSize={(clusters.get(key) ?? occupants.map(n => n.index)).length}
          selectedIndexes={selected}
          palette={palette}
          onPress={occupants.length > 0 ? onSelectCell : onEmptyCell}
          label={describeCell(
            x,
            y,
            occupants.map(node => node.index),
          )}
          disabled={disabled}
        />,
      );
    }
  }

  return (
    <View style={styles.frame}>
      {/* FRONT sits above the grid because Y=0 is the top row. The arrow
          points at the row it names rather than describing it in prose. */}
      <View style={styles.frontMarker}>
        <Icon name="arrow-up" size={16} color={colors.accentStrong} />
        <Text style={styles.frontText}>{frontLabel}</Text>
      </View>

      <View style={styles.edgeRow}>
        <Text style={[styles.edgeText, styles.edgeLeft]}>{leftLabel}</Text>
        <Text style={[styles.edgeText, styles.edgeRight]}>{rightLabel}</Text>
      </View>

      {/*
        The one scroll container in the screen. The page itself must never
        scroll sideways, so the 704-unit canvas is bounded here instead.

        LTR ON THIS SUBTREE IS THE FIX FOR A REAL DEFECT, not decoration.
        A horizontal scroller inherits the layout direction, and under RTL
        the scroll ORIGIN moves to the right: offset zero becomes the
        RIGHT edge, so a phone opening this screen showed the aircraft's
        right-hand side and LED 1 at x=2 sat off-screen to the left, with
        no forward scroll that could reach it.

        IT IS SET AS A DOM ATTRIBUTE, NOT AS A STYLE, and that distinction
        was itself a bug: `direction` is not part of the View style
        contract, so a `direction: 'ltr'` entry in the stylesheet is
        dropped on the floor and the scroller stays RTL. Measured in
        Chromium at 390px: with the style alone the canvas sat at
        left -337 and LED 1 at -249; with the attribute the canvas sits at
        23 and LED 1 at 111. `styles.viewport` deliberately no longer
        carries `direction` so nothing looks like it is doing this job
        twice.

        The cast is the price of a web DOM attribute in a shared
        component; `dir` is a forwarded prop, and on a platform that has
        no DOM it is simply ignored.
      */}
      <ScrollView
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator
        style={styles.viewport}
        contentContainerStyle={styles.viewportContent}
        {...({dir: 'ltr'} as object)}
        testID="led-grid-viewport">
        <View style={styles.canvas} testID="led-grid-canvas">
          {cells}
        </View>
      </ScrollView>

      <Text style={styles.rearText}>{rearLabel}</Text>
    </View>
  );
}

interface CellProps {
  readonly x: number;
  readonly y: number;
  readonly occupants: readonly LedDraftNode[];
  readonly clusterSize: number;
  readonly selectedIndexes: ReadonlySet<number>;
  readonly palette: readonly LedColorTriplet[] | undefined;
  readonly onPress: (x: number, y: number) => void;
  readonly label: string;
  readonly disabled: boolean;
}

const LedCell = React.memo(function LedCellContent({
  x,
  y,
  occupants,
  clusterSize,
  selectedIndexes,
  palette,
  onPress,
  label,
  disabled,
}: CellProps): React.JSX.Element {
  /* THE CELL SHOWS THE LED THE OPERATOR IS EDITING, not always the first
     one it happens to hold. On a shared coordinate, always drawing
     occupant zero means selecting the second LED changes the inspector
     and leaves the grid still reading "1" - the operator would be editing
     one LED while looking at another's number. */
  const head = occupants.find(node => selectedIndexes.has(node.index)) ?? occupants[0];
  const selected = head !== undefined && selectedIndexes.has(head.index);
  const swatch = head === undefined ? undefined : palette?.[head.colorIndex];
  const filled = swatch !== undefined && !ledColorIsOff(swatch);

  return (
    <Pressable
      onPress={() => onPress(x, y)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected, disabled}}
      testID={`led-cell-${x}-${y}`}
      style={[
        styles.cell,
        /* PHYSICAL PLACEMENT. `left` and `top`, never `start`, and never a
           flex row - so the layout direction cannot reach this. */
        {left: ledCellLeft(x), top: ledCellTop(y)},
      ]}>
      {/* AN EMPTY CELL IS A HINT, NOT A CONTROL. Drawing all 256 of them
          as outlined boxes made a strip of four LEDs read as a wall of
          empty squares; the LEDs are the content, the lattice is the
          backdrop. */}
      {head === undefined && <View style={styles.emptyDot} />}
      <View
        style={[
          styles.pad,
          head !== undefined && styles.padFilled,
          head?.isPending === true && styles.padPending,
          filled ? {backgroundColor: ledColorToCss(swatch)} : undefined,
          selected && styles.padSelected,
        ]}>
        {head !== undefined && (
          <Text
            style={[
              styles.number,
              filled ? {color: ledSwatchInk(swatch)} : undefined,
            ]}
            testID={`led-node-${head.index}`}>
            {head.number}
          </Text>
        )}
        {clusterSize > 1 && (
          <Text style={styles.cluster} testID={`led-cluster-${x}-${y}`}>
            {`×${clusterSize}`}
          </Text>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  frame: {
    gap: spacing.xs,
  },
  frontMarker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  frontText: {
    ...typography.label,
    color: colors.accentStrong,
  },
  edgeRow: {
    height: 16,
  },
  edgeText: {
    ...typography.caption,
    color: colors.textMuted,
    position: 'absolute',
    top: 0,
  },
  edgeLeft: {left: 0},
  edgeRight: {right: 0},
  viewport: {
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  viewportContent: {
    padding: spacing.xs,
  },
  canvas: {
    width: LED_GRID_EXTENT,
    height: LED_GRID_EXTENT,
  },
  cell: {
    position: 'absolute',
    width: LED_CELL_SIZE,
    height: LED_CELL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pad: {
    position: 'absolute',
    left: CELL_INSET,
    top: CELL_INSET,
    right: CELL_INSET,
    bottom: CELL_INSET,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  padFilled: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.backgroundRaised,
  },
  padPending: {
    borderStyle: 'dashed',
    borderColor: colors.accentStrong,
    borderWidth: 2,
  },
  padSelected: {
    borderWidth: 3,
    borderColor: colors.accentStrong,
  },
  number: {
    ...typography.label,
    color: colors.textPrimary,
  },
  cluster: {
    ...typography.caption,
    color: colors.textSecondary,
    position: 'absolute',
    right: 2,
    bottom: 0,
  },
  rearText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
});

export default LedGridCanvas;
