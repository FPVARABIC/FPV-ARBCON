/**
 * KEEPS THE ACTIVE NAVIGATION DESTINATION INSIDE THE VISIBLE VIEWPORT.
 *
 * Fifteen destinations do not fit in a phone's tab strip or in a rail on
 * a short window, so some of them are always outside the viewport. The
 * active one being among them is not hypothetical: screens change the tab
 * programmatically (Setup's GPS card, Configurations' four shortcuts,
 * Failsafe -> Receiver, every screen's "open Motors"), so the operator can
 * land on a destination whose entry is scrolled out of sight, with no
 * indication of where they are.
 *
 * Both navigation surfaces share this, so the bar and the rail cannot
 * drift apart.
 *
 * WHY CENTRE RATHER THAN "SCROLL ONLY IF OFF-SCREEN": centring needs no
 * knowledge of the CURRENT scroll offset, which is the one quantity whose
 * sign convention differs between Android and the browser. Reading it
 * back correctly on both would add a second translation for no visible
 * benefit - and centring the selection is what a scrollable tab strip is
 * expected to do anyway.
 */
import {useCallback, useEffect, useRef} from 'react';
import type {LayoutChangeEvent, ScrollView} from 'react-native';

import {horizontalScrollOffset} from './scrollOffset';

export interface RevealGeometry {
  /** The item's offset from the content's LEFT (x) or TOP (y) edge. */
  readonly itemStart: number;
  readonly itemSize: number;
  /** The scroll viewport along the same axis. */
  readonly viewportSize: number;
  /** The full scrollable content along the same axis. */
  readonly contentSize: number;
}

/**
 * The offset - measured from the content's LEFT/TOP edge - that centres
 * the item as far as the content allows.
 *
 * Always left/top-origin, on every platform. Translating that into what a
 * given platform's `scrollTo` expects is a separate, single concern (see
 * scrollOffset.ts / scrollOffset.web.ts), so this arithmetic stays
 * testable without a device.
 */
export function computeRevealOffset(geometry: RevealGeometry): number {
  const maxOffset = Math.max(0, geometry.contentSize - geometry.viewportSize);
  if (maxOffset === 0) {
    return 0;
  }
  const centred =
    geometry.itemStart + geometry.itemSize / 2 - geometry.viewportSize / 2;
  return Math.min(maxOffset, Math.max(0, centred));
}

export interface ActiveItemReveal<Key extends string> {
  readonly scrollRef: React.RefObject<ScrollView | null>;
  /** Attach to the ScrollView itself - measures the viewport. */
  readonly onScrollViewLayout: (event: LayoutChangeEvent) => void;
  /** Attach to the ScrollView's onContentSizeChange. */
  readonly onContentSizeChange: (width: number, height: number) => void;
  /** Attach to each destination: `onLayout={registerItem(key)}`. */
  readonly registerItem: (key: Key) => (event: LayoutChangeEvent) => void;
}

/**
 * Wires a ScrollView so the entry for `activeKey` is scrolled into view
 * whenever the selection, the measurements or the content size change.
 *
 * Geometry is held in refs, not state: these callbacks fire during layout
 * and must not schedule a render just to record a number.
 */
export function useActiveItemReveal<Key extends string>(
  activeKey: Key,
  axis: 'x' | 'y',
): ActiveItemReveal<Key> {
  const scrollRef = useRef<ScrollView | null>(null);
  const items = useRef(new Map<Key, {start: number; size: number}>());
  const viewportSize = useRef(0);
  const contentSize = useRef(0);
  /** The first reveal positions the strip; it must not animate into place. */
  const hasRevealed = useRef(false);

  const reveal = useCallback(() => {
    const item = items.current.get(activeKey);
    const scroller = scrollRef.current;
    if (
      item === undefined ||
      scroller === null ||
      viewportSize.current <= 0 ||
      contentSize.current <= 0
    ) {
      return;
    }
    const offset = computeRevealOffset({
      itemStart: item.start,
      itemSize: item.size,
      viewportSize: viewportSize.current,
      contentSize: contentSize.current,
    });
    const animated = hasRevealed.current;
    hasRevealed.current = true;
    if (axis === 'y') {
      scroller.scrollTo({y: offset, animated});
      return;
    }
    const maxOffset = Math.max(0, contentSize.current - viewportSize.current);
    scroller.scrollTo({
      x: horizontalScrollOffset(offset, maxOffset),
      animated,
    });
  }, [activeKey, axis]);

  useEffect(() => {
    reveal();
  }, [reveal]);

  const registerItem = useCallback(
    (key: Key) => (event: LayoutChangeEvent) => {
      const {x, y, width, height} = event.nativeEvent.layout;
      items.current.set(
        key,
        axis === 'y' ? {start: y, size: height} : {start: x, size: width},
      );
      if (key === activeKey) {
        reveal();
      }
    },
    [activeKey, axis, reveal],
  );

  const onScrollViewLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const {width, height} = event.nativeEvent.layout;
      viewportSize.current = axis === 'y' ? height : width;
      reveal();
    },
    [axis, reveal],
  );

  const onContentSizeChange = useCallback(
    (width: number, height: number) => {
      contentSize.current = axis === 'y' ? height : width;
      reveal();
    },
    [axis, reveal],
  );

  return {scrollRef, onScrollViewLayout, onContentSizeChange, registerItem};
}
