/**
 * The browser half of the horizontal scroll-coordinate translation.
 *
 * CHROME'S RTL SCROLL RANGE IS NON-POSITIVE. In a `dir="rtl"` document
 * `scrollLeft` runs from `-(scrollWidth - clientWidth)` up to 0, where 0
 * is the RIGHT edge - the mirror image of Android, which stays
 * left-origin and non-negative (see scrollOffset.ts for the evidence).
 * react-native-web does not reconcile this: its `scrollTo` assigns
 * `node.scrollLeft = x` verbatim, so a positive value simply clamps to 0
 * and the strip never moves.
 *
 * Measured on the real tab bar at 390px before this existed: scrollLeft
 * accepted -1314 (the far end) and clamped +99999 to 1.
 */
import {isRtlLayout} from '../../icons/layoutDirection';

/**
 * @param leftOriginOffset distance from the content's LEFT edge, 0..maxOffset
 * @param maxOffset the scrollable range (contentWidth - viewportWidth)
 */
export function horizontalScrollOffset(
  leftOriginOffset: number,
  maxOffset: number,
): number {
  return isRtlLayout() ? leftOriginOffset - maxOffset : leftOriginOffset;
}
