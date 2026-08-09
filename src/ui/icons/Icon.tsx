/**
 * <Icon/> — the ONE way this product draws an icon.
 *
 * Renders 24-grid Lucide stroke geometry (see glyphs.ts) through
 * react-native-svg, which produces a native drawing on Android and a real
 * <svg> element under react-native-web — the same optical result on both
 * platforms from the same registry.
 *
 * SIZING LANGUAGE (matches the design pass that introduced this system):
 *   18–20  inline/support icon beside text
 *   20–22  normal action icon inside a button or row
 *   22–24  important section/action icon
 * The stroke stays 2 at every size — scaling the stroke down with the
 * box is exactly how icons end up "weak and thin".
 *
 * DIRECTION. Raw glyph names ('chevron-left', 'arrow-up', …) draw exactly
 * as registered and NEVER auto-mirror — a GPS bearing arrow must not flip
 * because the UI is Arabic. Navigation semantics use the alias names
 * instead: 'chevron-forward' / 'chevron-back' / 'arrow-forward' /
 * 'arrow-back' resolve against the LIVE layout direction at render time
 * (see layoutDirection.ts / .web.ts — react-native-web's I18nManager is a
 * no-op stub and cannot answer this), so
 * "forward" points left in this RTL-first app and would point right if
 * the app ever hosted an LTR locale. Choose by MEANING: geometry names
 * for geometry, alias names for navigation.
 *
 * ACCESSIBILITY. An icon is decorative by default (hidden from the
 * accessibility tree) because it sits beside a text label. An icon that
 * IS the whole control must get its label from the surrounding
 * Pressable — never from the drawing.
 */
import React from 'react';
import type {ViewStyle} from 'react-native';
import Svg, {Circle, Line, Path, Polygon, Polyline, Rect} from 'react-native-svg';

import {colors} from '../theme';
import {isRtlLayout} from './layoutDirection';
import {glyphs} from './glyphs';
import type {GlyphName, IconElement} from './glyphs';

/** Navigation aliases resolved against the active layout direction. */
const DIRECTIONAL_ALIASES = {
  'chevron-forward': {rtl: 'chevron-left', ltr: 'chevron-right'},
  'chevron-back': {rtl: 'chevron-right', ltr: 'chevron-left'},
  'arrow-forward': {rtl: 'arrow-left', ltr: 'arrow-right'},
  'arrow-back': {rtl: 'arrow-right', ltr: 'arrow-left'},
} as const satisfies Record<string, {rtl: GlyphName; ltr: GlyphName}>;

export type IconName = GlyphName | keyof typeof DIRECTIONAL_ALIASES;

export interface IconProps {
  name: IconName;
  /** Optical box in px. Default 20 — the inline/support size. */
  size?: number;
  /** Stroke colour. Defaults to the primary ink. */
  color?: string;
  /** Lucide native stroke is 2. Raise to 2.25–2.5 only for a deliberate
   * emphasis icon; never lower it below 1.75. */
  strokeWidth?: number;
  /** Kept to the plain object/array forms so the same prop typechecks
   * against both the native and web type surfaces of react-native-svg. */
  style?: ViewStyle | ViewStyle[];
  testID?: string;
}

function resolveGlyph(name: IconName): readonly IconElement[] {
  if (name in DIRECTIONAL_ALIASES) {
    const alias = DIRECTIONAL_ALIASES[name as keyof typeof DIRECTIONAL_ALIASES];
    return glyphs[isRtlLayout() ? alias.rtl : alias.ltr];
  }
  return glyphs[name as GlyphName];
}

export function Icon({
  name,
  size = 20,
  color = colors.textPrimary,
  strokeWidth = 2,
  style,
  testID,
}: IconProps): React.JSX.Element {
  const elements = resolveGlyph(name);
  // Always hand react-native-svg an ARRAY: its web type surface requires
  // an iterable style, its native surface accepts one, and normalising
  // here keeps the caller-facing prop ergonomic.
  const svgStyle = style === undefined ? undefined : ([] as ViewStyle[]).concat(style);
  return (
    <Svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={svgStyle}
      testID={testID}
      // Decorative by contract (the icon always sits beside a text label
      // or inside a labelled control). The two RN props below are
      // Android-only; without aria-hidden every icon also reached the
      // BROWSER accessibility tree as an unnamed graphic — measured, not
      // assumed: 12 of 12 SVGs were exposed on the Ports screen.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden>
      {elements.map((el, i) => {
        switch (el.t) {
          case 'p':
            return <Path key={i} d={el.d} />;
          case 'c':
            return <Circle key={i} cx={el.cx} cy={el.cy} r={el.r} />;
          case 'r':
            return (
              <Rect
                key={i}
                x={el.x}
                y={el.y}
                width={el.w}
                height={el.h}
                rx={el.rx}
                ry={el.ry}
              />
            );
          case 'l':
            return <Line key={i} x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} />;
          case 'pl':
            return <Polyline key={i} points={el.pts} />;
          case 'pg':
            return <Polygon key={i} points={el.pts} />;
        }
      })}
    </Svg>
  );
}
