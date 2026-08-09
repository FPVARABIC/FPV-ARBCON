/**
 * An icon-only control with a guaranteed comfortable target.
 *
 * The visible glyph may be 20–22px, but the pressable box never drops
 * below 44×44 (MIN_TOUCH_TARGET) — the audit found icon controls at ~36px
 * and smaller. Because there is no visible text, accessibilityLabel is
 * REQUIRED at the type level: an unlabelled icon button is a hole in the
 * screen for a screen-reader user.
 */
import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import type {StyleProp, ViewStyle} from 'react-native';

import {Icon} from '../../icons';
import type {IconName} from '../../icons';
import {colors, radii} from '../../theme';
import {MIN_TOUCH_TARGET, readInteraction} from './interaction';

export interface IconButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  /** Glyph size. The hit target stays 44 regardless. */
  size?: number;
  color?: string;
  disabled?: boolean;
  /** 'plain' = transparent until hovered/pressed; 'outlined' = reads as a
   * button at rest (surface fill + strong border). */
  appearance?: 'plain' | 'outlined';
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 20,
  color = colors.textPrimary,
  disabled = false,
  appearance = 'plain',
  testID,
  style,
}: IconButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{disabled}}
      testID={testID}
      style={state => {
        const {pressed, hovered} = readInteraction(state);
        return [
          styles.base,
          appearance === 'outlined' && styles.outlined,
          hovered && !disabled && styles.hovered,
          pressed && !disabled && styles.pressed,
          disabled && appearance === 'outlined' && styles.disabledOutlined,
          style,
        ];
      }}>
      <Icon
        name={icon}
        size={size}
        color={disabled ? colors.textMuted : color}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  outlined: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  hovered: {backgroundColor: colors.surfaceHover},
  pressed: {backgroundColor: colors.surfacePressed},
  disabledOutlined: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSoft,
  },
});
