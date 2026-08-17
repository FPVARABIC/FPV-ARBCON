/**
 * The product's ONE button.
 *
 * Before this existed the codebase carried at least nine independent
 * Pressable+Text recipes (three radii, two disabled treatments and zero
 * pressed/hover/focus feedback among them — see the 2026-08 UI audit).
 * Every action surface converges here so "primary action" looks like the
 * same object on the Connection screen, the Motors bench and the flasher.
 *
 *   primary    the screen's main affirmative action (accent fill)
 *   secondary  a normal action (solid surface, strong border)
 *   danger     destructive/irreversible (error fill)
 *   ghost      low-emphasis inline action (text + hover wash only)
 *
 * Interaction states are real, not decorative: hover (web), pressed
 * (both), focus (web ring via the global :focus-visible CSS), disabled
 * (dimmed surface but STILL READABLE text — an operator must be able to
 * read what it is they cannot press, and why the label says so).
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {StyleProp, ViewStyle} from 'react-native';

import {Icon} from '../../icons';
import type {IconName} from '../../icons';
import {colors, radii, spacing, typography} from '../../theme';
import {MIN_TOUCH_TARGET, readInteraction} from './interaction';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
/**
 * `sm` is narrower, NOT shorter. A small action - "read again", "open
 * Motors", a row-level correction - does not need the horizontal weight of a
 * primary CTA, and giving it that weight was making minor actions compete
 * with the one the operator actually came for. The 44pt minimum touch target
 * is an accessibility floor and is NOT traded away for density: `sm` keeps
 * exactly the same height as `md` and only takes back the padding.
 */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon, drawn in the label colour at the size's icon scale. */
  icon?: IconName;
  disabled?: boolean;
  /** Stretch to the container width (row of actions vs inline action). */
  block?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

interface VariantColors {
  bg: string;
  bgHover: string;
  bgPressed: string;
  border: string;
  fg: string;
}

const VARIANTS: Record<ButtonVariant, VariantColors> = {
  primary: {
    bg: colors.accent,
    bgHover: colors.accentHover,
    bgPressed: colors.accentPressed,
    border: 'transparent',
    fg: colors.accentText,
  },
  secondary: {
    bg: colors.surface,
    bgHover: colors.surfaceHover,
    bgPressed: colors.surfacePressed,
    border: colors.borderStrong,
    fg: colors.textPrimary,
  },
  danger: {
    bg: colors.error,
    bgHover: colors.errorHover,
    bgPressed: colors.errorPressed,
    border: 'transparent',
    fg: colors.white,
  },
  ghost: {
    bg: 'transparent',
    bgHover: colors.surfaceHover,
    bgPressed: colors.surfacePressed,
    border: 'transparent',
    fg: colors.accentStrong,
  },
};

export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  icon,
  disabled = false,
  block = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps): React.JSX.Element {
  const palette = VARIANTS[variant];
  const iconSize = size === 'lg' ? 22 : 20;
  const fg = disabled ? colors.textMuted : palette.fg;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{disabled}}
      testID={testID}
      style={state => {
        const {pressed, hovered} = readInteraction(state);
        return [
          styles.base,
          styles[size],
          {backgroundColor: palette.bg, borderColor: palette.border},
          hovered && !disabled && {backgroundColor: palette.bgHover},
          pressed && !disabled && {backgroundColor: palette.bgPressed},
          disabled && styles.disabled,
          block && styles.block,
          style,
        ];
      }}>
      {icon ? (
        <View style={styles.iconSlot}>
          <Icon name={icon} size={iconSize} color={fg} />
        </View>
      ) : null}
      <Text
        style={[
          typography.label,
          size === 'lg' && styles.lgText,
          {color: fg},
          styles.labelText,
        ]}
        numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    paddingHorizontal: spacing.lg,
  },
  sm: {minHeight: MIN_TOUCH_TARGET, paddingHorizontal: spacing.md},
  md: {minHeight: MIN_TOUCH_TARGET},
  lg: {minHeight: 52, paddingHorizontal: spacing.xl},
  lgText: {fontSize: 16, lineHeight: 27},
  labelText: {textAlign: 'center'},
  iconSlot: {
    // The icon never dictates row height; the minHeight does.
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSoft,
  },
  block: {alignSelf: 'stretch'},
});
