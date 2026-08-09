import type {TextStyle} from 'react-native';
import {fonts} from './font';

/**
 * The Cairo type scale — the single typographic vocabulary of the product.
 *
 * HIERARCHY (weights follow the product rule: reading text 400/500,
 * labels and controls 500/600, section headings 600, page headings 700 —
 * never thinner than 400, never heavier than 700):
 *
 *   display      page hero (Start screen brand line)
 *   title        page heading
 *   sectionTitle section heading inside a page or card
 *   heading      compact strong heading INSIDE a card/panel body
 *   bodyStrong   a setting's NAME — reads a step above its description
 *   body         explanatory/reading text
 *   label        text on controls: buttons, tabs, chips, field labels
 *   value        a measured/edited value — the number the operator came for
 *   caption      secondary metadata under a value or row
 *   helper       fine print: hints, footnotes; NEVER for primary content
 *   eyebrow      small category marker above a title
 *   mono         terminal/code/identifiers — deliberately NOT Cairo
 *
 * LINE-HEIGHTS ARE ~1.7× ON PURPOSE. Cairo's Arabic ascenders and
 * descenders (teeth, bowls, marks) genuinely occupy that vertical span;
 * the previous ~1.45× values compressed Arabic vertically and clipped
 * descenders on Android, which forces line boxes. Do not tighten these
 * for visual density — cut copy instead.
 *
 * letterSpacing stays 0 everywhere: Arabic is a connected script, and
 * tracking visually tears the ligature joins apart (the old 0.8 eyebrow
 * tracking did exactly that).
 *
 * THE TYPE IS DELIBERATELY EXACT, not Record<string, TextStyle>. Under
 * the old open Record, 28 call sites spread `typography.heading` and
 * `typography.screenTitle` — keys that DID NOT EXIST — and TypeScript
 * accepted the resulting `undefined` silently, so those "headings"
 * rendered as bare default text. That is precisely how a hierarchy
 * flattens without anyone noticing. With the exact type, a phantom
 * token is now a compile error.
 */
export const typography = {
  display: {
    fontFamily: fonts.family,
    fontSize: 26,
    lineHeight: 44,
    fontWeight: '700',
  },
  title: {
    fontFamily: fonts.family,
    fontSize: 21,
    lineHeight: 36,
    fontWeight: '700',
  },
  sectionTitle: {
    fontFamily: fonts.family,
    fontSize: 17,
    lineHeight: 29,
    fontWeight: '600',
  },
  heading: {
    fontFamily: fonts.family,
    fontSize: 16,
    lineHeight: 27,
    fontWeight: '700',
  },
  bodyStrong: {
    fontFamily: fonts.family,
    fontSize: 15,
    lineHeight: 26,
    fontWeight: '600',
  },
  body: {
    fontFamily: fonts.family,
    fontSize: 15,
    lineHeight: 26,
    fontWeight: '400',
  },
  label: {
    fontFamily: fonts.family,
    fontSize: 14,
    lineHeight: 24,
    fontWeight: '600',
  },
  value: {
    fontFamily: fonts.family,
    fontSize: 16,
    lineHeight: 27,
    fontWeight: '600',
  },
  caption: {
    fontFamily: fonts.family,
    fontSize: 13,
    lineHeight: 22,
    fontWeight: '500',
  },
  helper: {
    fontFamily: fonts.family,
    fontSize: 12,
    lineHeight: 20,
    fontWeight: '400',
  },
  eyebrow: {
    fontFamily: fonts.family,
    fontSize: 12,
    lineHeight: 20,
    fontWeight: '700',
    letterSpacing: 0,
  },
  mono: {fontFamily: fonts.mono, fontSize: 14, lineHeight: 22},
} as const satisfies Record<string, TextStyle>;

export type TypographyToken = keyof typeof typography;
