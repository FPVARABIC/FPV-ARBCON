/**
 * The one place a screen asks "how wide may my content be right now".
 *
 * WHY A HOOK. Every post-connection screen previously hard-coded
 * `maxWidth: 1180` in its StyleSheet - a static reading-column cap that
 * left a 1920px window mostly empty, which is what the operator
 * described as "a mobile phone interface inside a desktop monitor". A
 * StyleSheet literal cannot depend on the viewport, so the decision has
 * to move to render time.
 *
 * READABILITY IS STILL PROTECTED. A screen may only pass
 * `splitsIntoColumns: true` when it genuinely arranges content side by
 * side; contentEnvelope() then allows the wider workspace envelope. A
 * screen that is one column of prose keeps the 1180px reading cap no
 * matter how large the window is - widening that would trade one bad
 * layout for another.
 */

import { useWindowDimensions } from 'react-native';

import { contentEnvelope, resolveLayoutTier } from './layout';
import type { LayoutTier } from './layout';

export interface ContentEnvelope {
  readonly tier: LayoutTier;
  /**
   * The maxWidth the screen's content container should use, or
   * `undefined` for a desktop tool workspace, which takes the width the
   * shell gave it. See contentEnvelope() for why that is an answer
   * rather than an omission - and note that a consumer must not keep a
   * static `maxWidth` in its StyleSheet as a "fallback", because an
   * inline `undefined` cannot override one.
   */
  readonly maxWidth: number | undefined;
}

export function useContentEnvelope(splitsIntoColumns: boolean): ContentEnvelope {
  const { width, fontScale } = useWindowDimensions();
  const tier = resolveLayoutTier(width, fontScale);
  return { tier, maxWidth: contentEnvelope(tier, splitsIntoColumns) };
}
