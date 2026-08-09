/**
 * TRANSLATES A LEFT-ORIGIN SCROLL DISTANCE INTO THE PLATFORM'S OWN
 * HORIZONTAL SCROLL COORDINATE.
 *
 * The two platforms genuinely disagree under RTL, so a single number
 * cannot be handed to both. This is the native half.
 *
 * ANDROID IS LEFT-ORIGIN AND NON-NEGATIVE, even under RTL. Two pieces of
 * evidence from React Native's own Android sources rather than
 * assumption:
 *   - ReactHorizontalScrollViewManager.scrollTo() passes `mDestX`
 *     straight to `View.scrollTo(x, y)`, and scrollToEnd() passes
 *     `child.width` - both plain left-origin values, with no mirroring.
 *   - ReactHorizontalScrollView's snap code converts with
 *     `targetOffset = maximumOffset - targetOffset` under
 *     LAYOUT_DIRECTION_RTL, which is only necessary BECAUSE getScrollX()
 *     is left-origin there.
 *
 * So the identity is correct here, and the browser needs the other half
 * (see scrollOffset.web.ts). Split by file extension, never by a
 * Platform.OS branch, per this codebase's rule.
 */

/**
 * @param leftOriginOffset distance from the content's LEFT edge, 0..maxOffset
 * @param _maxOffset the scrollable range; unused natively, see the web pair
 */
export function horizontalScrollOffset(
  leftOriginOffset: number,
  _maxOffset: number,
): number {
  return leftOriginOffset;
}
