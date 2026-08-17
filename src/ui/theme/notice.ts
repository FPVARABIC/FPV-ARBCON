// Imported from the source modules, NOT the barrel: the barrel re-exports
// this file, and a cycle through it would leave these tokens undefined at
// module-init time on some bundlers - a failure that typechecks cleanly.
import {radii} from './radii';
import {spacing} from './spacing';
import {typography} from './typography';
import type {TextStyle, ViewStyle} from 'react-native';

/**
 * ONE SIZE FOR EVERY STATUS MESSAGE IN THE APP.
 *
 * The shared NoticeBox was brought down to a compact scale, but an audit
 * found it used in only five places against seventeen hand-rolled banners
 * across twelve files - built from `padding: spacing.md`, `radii.lg` and
 * `typography.heading`, so the fix to the shared component never reached
 * them. A one-line "settings changed, read again" was rendered as a card
 * taller than the setting it referred to, and several screens stacked two or
 * three of those above the first real control.
 *
 * The metrics live here so there is a single thing to change, rather than
 * seventeen copies that drift apart again. Screens keep their own colours -
 * a danger banner and a success banner should not look alike - and spread
 * these for shape and type.
 *
 * A notice is CONTEXT, not content. Its size should follow from how much it
 * has to say, which is what `noticeSurface` (a block) and `noticeInline` (a
 * single line beside its own control) are for. Nothing here weakens a safety
 * warning: the words, the colour and the icon are untouched, and a danger
 * notice still announces itself to assistive technology.
 */

/** A block notice: its own row, sized to its text. */
export const noticeSurface: ViewStyle = {
  borderWidth: 1,
  borderRadius: radii.sm,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm,
  gap: 2,
};

/**
 * A single-line notice that sits beside the control it is about, rather than
 * spanning the screen. `alignSelf: 'flex-start'` is the point: it stops a
 * four-word message from becoming a full-width bar.
 */
export const noticeInline: ViewStyle = {
  alignSelf: 'flex-start',
  flexDirection: 'row',
  alignItems: 'center',
  gap: spacing.xs,
  borderWidth: 1,
  borderRadius: radii.pill,
  paddingHorizontal: spacing.sm,
  paddingVertical: 2,
};

/** Notice body text. One step below body, which is where context belongs. */
export const noticeText: TextStyle = {
  ...typography.caption,
  textAlign: 'right',
  writingDirection: 'rtl',
};

/** Notice title. Same size as the body, distinguished by weight, not scale. */
export const noticeTitle: TextStyle = {
  ...noticeText,
  fontWeight: '700',
};
