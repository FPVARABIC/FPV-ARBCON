/**
 * A small set of mutually-exclusive choices, shown flat (no dropdown).
 *
 * This is the right control when the option count is small enough to
 * show entirely — cell counts, protocols, profiles. The selected chip
 * must be readable AS selected from across a bench: accent-tinted fill,
 * strong border and a leading check, not a colour change alone.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {Icon} from '../../icons';
import {colors, radii, spacing, typography} from '../../theme';
import {MIN_TOUCH_TARGET, readInteraction} from './interaction';

export interface ChoiceOption<K extends string = string> {
  key: K;
  label: string;
  disabled?: boolean;
  /** Small second line inside the chip — e.g. "not compiled in this
   * firmware". Rendered at the helper size, never below 12px. */
  note?: string;
  /** Override the derived `${testID}-${key}` id where a screen already
   * published a different one to its tests. */
  testID?: string;
}

export interface ChoiceChipsProps<K extends string = string> {
  options: ReadonlyArray<ChoiceOption<K>>;
  selectedKey: K | null;
  onSelect: (key: K) => void;
  disabled?: boolean;
  /** Names the group for screen readers, e.g. the setting name. */
  accessibilityLabel: string;
  testID?: string;
}

export function ChoiceChips<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  disabled = false,
  accessibilityLabel,
  testID,
}: ChoiceChipsProps<K>): React.JSX.Element {
  return (
    <View
      style={styles.row}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      testID={testID}>
      {options.map(option => {
        const selected = option.key === selectedKey;
        const optionDisabled = disabled || option.disabled === true;
        return (
          <Pressable
            key={option.key}
            onPress={() => onSelect(option.key)}
            disabled={optionDisabled}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{selected, disabled: optionDisabled}}
            // A radio's state is aria-checked, and react-native-web emits
            // neither that nor aria-selected from accessibilityState —
            // verified in a browser. Core RN aria props, so native keeps
            // working unchanged.
            aria-checked={selected}
            aria-disabled={optionDisabled}
            testID={
              option.testID ??
              (testID ? `${testID}-${option.key}` : undefined)
            }
            style={state => {
              const {pressed, hovered} = readInteraction(state);
              return [
                styles.chip,
                selected ? styles.chipSelected : styles.chipIdle,
                hovered && !optionDisabled && !selected && styles.chipHovered,
                pressed && !optionDisabled && styles.chipPressed,
                optionDisabled && styles.chipDisabled,
              ];
            }}>
            {selected ? (
              <Icon name="check" size={18} color={colors.accentStrong} />
            ) : null}
            <View style={styles.chipTextColumn}>
              <Text
                style={[
                  typography.label,
                  selected ? styles.textSelected : styles.textIdle,
                  optionDisabled && styles.textDisabled,
                ]}>
                {option.label}
              </Text>
              {option.note ? (
                <Text style={styles.note}>{option.note}</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 72,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1.5,
  },
  chipIdle: {
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.border,
  },
  chipSelected: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentStrong,
  },
  chipHovered: {backgroundColor: colors.surfaceHover},
  chipPressed: {backgroundColor: colors.surfacePressed},
  chipDisabled: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderSoft,
  },
  chipTextColumn: {alignItems: 'center'},
  note: {
    ...typography.helper,
    color: colors.textMuted,
    textAlign: 'center',
  },
  textIdle: {color: colors.textSecondary},
  textSelected: {color: colors.accentStrong},
  textDisabled: {color: colors.textMuted},
});
