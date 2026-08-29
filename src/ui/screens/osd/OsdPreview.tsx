/**
 * THE OSD PREVIEW - the surface the operator actually drags.
 *
 * THE DEFECT THIS REPLACES. The old preview drew each element as a
 * Pressable whose only handler was onPress: touching an element SELECTED
 * it, and the sole way to move it afterwards was a pair of +/- steppers
 * further down the page. Nothing in the preview could follow a finger, so
 * the screen presented itself as a layout editor and behaved as a legend.
 *
 * HOW THE GESTURE IS OWNED. One PanResponder on the CANVAS, never one per
 * element:
 *
 *   - every child (background photo, guides, element tokens) is
 *     pointerEvents="none", so the canvas is always the event target and
 *     `locationX/locationY` are therefore always canvas-relative. That is
 *     what makes the mapping immune to page scrolling - no page origin is
 *     measured, so none can go stale mid-drag;
 *   - which element a touch grabs is decided by a pure hit test against
 *     the same cells that are drawn, walked topmost-first;
 *   - the responder refuses termination requests and the page stops
 *     scrolling for the duration, so a drag cannot be stolen halfway by
 *     the ScrollView underneath it;
 *   - release, cancellation, and (on web) the window losing focus all end
 *     the gesture through ONE path, so no drag can be left stuck owning
 *     the pointer.
 *
 * WHAT A DRAG CHANGES. Only the element's character cell in the draft.
 * The preview never writes to the flight controller and the photograph
 * behind it is decoration: what is dragged is a (column, row) pair, which
 * is exactly what Betaflight stores.
 *
 * DIRECTION. The canvas is pinned `direction: 'ltr'`. The interface is
 * Arabic and RTL, but this rectangle is the pilot's video: its left is
 * physically left on the goggles. Pinning it here means no locale can
 * mirror the geometry, and the arithmetic itself lives in pure functions
 * that have no idea a language exists.
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';

import {
  beginOsdDrag,
  hitTestOsdElements,
  osdCellToFraction,
  osdCellSize,
  osdElementToken,
  osdPreviewAspectRatio,
  resolveOsdDragCell,
  type MspOsdCanvas,
  type OsdCell,
  type OsdDragGrab,
  type OsdHitTarget,
  type OsdPreviewBox,
} from '../../../core';
import {colors, fonts, radii} from '../../theme';
import {OSD_PREVIEW_BACKGROUND_URI} from './osdPreviewBackground';

export interface OsdPreviewElement {
  readonly index: number;
  readonly cell: OsdCell;
}

export interface OsdPreviewProps {
  readonly canvas: MspOsdCanvas;
  /** Elements visible in the active profile, in draw order. */
  readonly elements: readonly OsdPreviewElement[];
  readonly selectedIndex: number;
  readonly interactive: boolean;
  readonly onSelect: (index: number) => void;
  readonly onMove: (index: number, cell: OsdCell) => void;
  readonly onDragStateChange?: (dragging: boolean) => void;
}

/** Local coordinates of a responder event inside the canvas. */
function localPoint(event: GestureResponderEvent): {x: number; y: number} {
  const {locationX, locationY} = event.nativeEvent;
  return {
    x: Number.isFinite(locationX) ? locationX : 0,
    y: Number.isFinite(locationY) ? locationY : 0,
  };
}

export function OsdPreview({
  canvas,
  elements,
  selectedIndex,
  interactive,
  onSelect,
  onMove,
  onDragStateChange,
}: OsdPreviewProps): React.JSX.Element {
  const [box, setBox] = useState<OsdPreviewBox>({width: 0, height: 0});
  const [draggingIndex, setDraggingIndex] = useState<number | undefined>(undefined);

  /* Refs, not state, for everything the gesture reads: a responder
   * callback captured at creation must see the CURRENT canvas and
   * elements, and re-creating the responder mid-drag would hand the
   * gesture to a different object. */
  const boxRef = useRef(box);
  const canvasRef = useRef(canvas);
  const elementsRef = useRef(elements);
  const interactiveRef = useRef(interactive);
  const grabRef = useRef<OsdDragGrab | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  const onMoveRef = useRef(onMove);
  const onDragStateChangeRef = useRef(onDragStateChange);

  boxRef.current = box;
  canvasRef.current = canvas;
  elementsRef.current = elements;
  interactiveRef.current = interactive;
  onSelectRef.current = onSelect;
  onMoveRef.current = onMove;
  onDragStateChangeRef.current = onDragStateChange;

  const hitTargets = useMemo<readonly OsdHitTarget[]>(
    () =>
      elements.map(element => ({
        index: element.index,
        cell: element.cell,
        widthInCells: osdElementToken(element.index).length,
      })),
    [elements],
  );
  const hitTargetsRef = useRef(hitTargets);
  hitTargetsRef.current = hitTargets;

  const endDrag = useCallback(() => {
    if (grabRef.current === undefined) {
      return;
    }
    grabRef.current = undefined;
    setDraggingIndex(undefined);
    onDragStateChangeRef.current?.(false);
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => interactiveRef.current,
        onMoveShouldSetPanResponder: () => interactiveRef.current,
        // A gesture that has grabbed an element keeps it. Without this a
        // ScrollView ancestor can ask for the responder as soon as the
        // finger travels far enough and the element is dropped mid-air.
        onPanResponderTerminationRequest: () => grabRef.current === undefined,
        onPanResponderGrant: event => {
          if (!interactiveRef.current) {
            return;
          }
          const point = localPoint(event);
          const hit = hitTestOsdElements(
            point,
            boxRef.current,
            canvasRef.current,
            hitTargetsRef.current,
          );
          if (hit === undefined) {
            return;
          }
          const element = elementsRef.current.find(item => item.index === hit);
          if (element === undefined) {
            return;
          }
          grabRef.current = beginOsdDrag(
            hit,
            element.cell,
            point,
            boxRef.current,
            canvasRef.current,
          );
          setDraggingIndex(hit);
          onSelectRef.current(hit);
          onDragStateChangeRef.current?.(true);
        },
        onPanResponderMove: event => {
          const grab = grabRef.current;
          if (grab === undefined) {
            return;
          }
          const cell = resolveOsdDragCell(
            grab,
            localPoint(event),
            boxRef.current,
            canvasRef.current,
          );
          onMoveRef.current(grab.elementIndex, cell);
        },
        onPanResponderRelease: () => endDrag(),
        onPanResponderTerminate: () => endDrag(),
      }),
    [endDrag],
  );

  /* The browser can take the pointer away without ever delivering a
   * cancel - alt-tab, a devtools break, a dragged file. Any of those
   * would otherwise leave the canvas convinced a finger is still down.
   * Reached through globalThis because this component is shared: the
   * native TypeScript project has no DOM lib to name `window` from. */
  useEffect(() => {
    const view = globalThis as {
      addEventListener?: (type: string, handler: () => void) => void;
      removeEventListener?: (type: string, handler: () => void) => void;
    };
    if (Platform.OS !== 'web' || typeof view.addEventListener !== 'function') {
      return undefined;
    }
    const handle = () => endDrag();
    view.addEventListener('blur', handle);
    return () => view.removeEventListener?.('blur', handle);
  }, [endDrag]);

  /* An element cannot stay grabbed once the surface stops accepting
   * gestures (link lost, save in flight, tab left). */
  useEffect(() => {
    if (!interactive) {
      endDrag();
    }
  }, [endDrag, interactive]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const {width, height} = event.nativeEvent.layout;
    setBox(previous =>
      previous.width === width && previous.height === height
        ? previous
        : {width, height},
    );
  }, []);

  const cell = osdCellSize(box, canvas);
  const fontSize = Math.max(7, Math.min(20, cell.height * 0.74));
  /**
   * ONE ELEMENT OCCUPIES EXACTLY ONE ROW.
   *
   * Both the item box and its line box used to be floored at 10px. On a
   * 360px-wide screen the canvas gives each row 9.05px, so every element
   * was 12px tall (10 plus its 1px borders) in a 9.05px row and each one
   * painted 3px into the row below - measured, and confirmed by hiding
   * each node and re-photographing the band, so it was ink and not a box
   * artifact. A preview whose rows collide is not showing the operator
   * what the goggles will show.
   *
   * The floor only ever applied below ~9.5px of row height, which is
   * exactly where it did the damage. The fallback here is for the single
   * frame before onLayout has measured anything, where no element has a
   * meaningful position yet.
   */
  const rowHeight = cell.height > 0 ? cell.height : 10;
  const selectedElement = elements.find(item => item.index === selectedIndex);
  const guideCell = draggingIndex === undefined ? undefined : selectedElement?.cell;

  return (
    <View style={styles.frame}>
      <View
        testID="osd-canvas"
        onLayout={onLayout}
        accessibilityLabel="معاينة OSD"
        style={[
          styles.canvas,
          {aspectRatio: osdPreviewAspectRatio(canvas)},
          CANVAS_PHYSICAL_DIRECTION,
          WEB_CANVAS_STYLE,
        ]}
        {...responder.panHandlers}>
        {/* The operator's own still. Decorative and inert: it is behind
            every element, it is not accessible content, and the wrapper's
            pointerEvents="none" means it can never become the gesture's
            target - so a drag started over the photograph is still a drag
            of the element above it. */}
        <View
          testID="osd-preview-background-layer"
          pointerEvents="none"
          style={styles.fill}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          <Image
            testID="osd-preview-background"
            source={{uri: OSD_PREVIEW_BACKGROUND_URI}}
            style={styles.fill}
            resizeMode="cover"
            accessible={false}
          />
          {/* A very light wash - enough that white characters stay
              legible over a bright sky, not enough to misrepresent the
              picture the operator chose. */}
          <View style={styles.scrim} />
        </View>

        {guideCell !== undefined && box.width > 0 ? (
          <>
            <View
              testID="osd-drag-guide-column"
              pointerEvents="none"
              style={[
                styles.guideColumn,
                {left: guideCell.column * cell.width, width: Math.max(1, cell.width)},
              ]}
            />
            <View
              testID="osd-drag-guide-row"
              pointerEvents="none"
              style={[
                styles.guideRow,
                {top: guideCell.row * cell.height, height: Math.max(1, cell.height)},
              ]}
            />
          </>
        ) : null}

        {elements.map(element => {
          const fraction = osdCellToFraction(element.cell, canvas);
          const isSelected = element.index === selectedIndex;
          return (
            <View
              key={element.index}
              testID={`osd-canvas-item-${element.index}`}
              pointerEvents="none"
              style={[
                styles.item,
                {
                  left: `${fraction.left}%`,
                  top: `${fraction.top}%`,
                  height: rowHeight,
                },
                isSelected && styles.itemSelected,
                element.index === draggingIndex && styles.itemDragging,
              ]}>
              <Text
                numberOfLines={1}
                style={[styles.itemText, {fontSize, lineHeight: rowHeight}]}>
                {osdElementToken(element.index)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/**
 * THE CANVAS IS PHYSICAL, AND THIS HAS TO BE AN INLINE STYLE.
 *
 * Measured, not assumed: react-native-web's StyleSheet.create DROPS
 * `direction` - a registered style carrying it arrives at the DOM without
 * it, so the Arabic shell's RTL would have flowed straight into the video
 * canvas while the source looked correct. Declared inline it survives on
 * both platforms, which is why it lives here rather than in the sheet.
 */
const CANVAS_PHYSICAL_DIRECTION = {direction: 'ltr'} as ViewStyle;

/**
 * Web only. `touch-action: none` is what stops a browser turning a drag
 * into a page pan before React ever sees the move, and the shell's
 * `user-select: none` policy already covers text selection - repeating it
 * here keeps the canvas correct even if this component is embedded
 * somewhere without that shell.
 */
const WEB_CANVAS_STYLE: ViewStyle | undefined =
  Platform.OS === 'web'
    ? ({touchAction: 'none', userSelect: 'none'} as unknown as ViewStyle)
    : undefined;

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    /**
     * HOW BIG A VIDEO PREVIEW IS WORTH BEING.
     *
     * The preview's job is to show WHERE each element sits on the frame,
     * and its glyphs stop growing: `fontSize` above is
     * `Math.min(20, cell.height * 0.74)`, so 20px is the ceiling.
     * Measured in Chromium on the real screen, canvas width against
     * rendered glyph size:
     *
     *      776px canvas -> 16.2px glyphs
     *     1032px canvas ->   20px glyphs   <- the ceiling is reached here
     *     1436px canvas ->   20px
     *     2312px canvas ->   20px
     *     3592px canvas ->   20px
     *
     * So past ~1032px nothing becomes more legible; the extra width only
     * spreads the characters further apart. It is not free, because the
     * frame keeps its aspect: at 3440 the preview grew to 3192x1807 and
     * filled an entire 1440px monitor by itself, putting all 88 element
     * chips below the fold. This bound is 1440 - about 40% past the point
     * legibility saturates, so drag precision keeps a margin - and it
     * lands the preview at ~813px tall, which leaves the grid on screen.
     *
     * It is a bound on ONE COMPONENT, not a workspace envelope: the
     * screen around it still takes the whole window. Below 1920 the
     * preview never reached this width, so nothing there changes.
     */
    maxWidth: 1440,
    alignSelf: 'center',
    borderRadius: radii.lg,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.accentStrong,
    backgroundColor: '#05131C',
  },
  // `direction` is applied inline instead of here - see
  // CANVAS_PHYSICAL_DIRECTION for the measured reason.
  canvas: {width: '100%', position: 'relative', overflow: 'hidden'},
  fill: {position: 'absolute', left: 0, right: 0, top: 0, bottom: 0},
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(2, 12, 20, 0.18)',
  },
  guideColumn: {position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(94, 234, 212, 0.22)'},
  guideRow: {position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(94, 234, 212, 0.22)'},
  item: {
    position: 'absolute',
    justifyContent: 'center',
    paddingHorizontal: 1,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  itemSelected: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(8, 37, 44, 0.55)',
  },
  itemDragging: {
    borderColor: colors.white,
    backgroundColor: 'rgba(18, 104, 116, 0.75)',
  },
  itemText: {
    fontFamily: fonts.mono,
    color: '#FFFFFF',
    // The outline analogue OSD characters have. Without it white text
    // over a bright sky is unreadable, which is the whole reason the
    // operator wanted a real photograph behind this.
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 2,
    includeFontPadding: false,
  },
});
