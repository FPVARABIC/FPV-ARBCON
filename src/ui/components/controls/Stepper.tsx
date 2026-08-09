/**
 * The numeric stepper — the − [value] + control.
 *
 * Two screens (PowerBattery, PidTuning) had drawn their own with typed
 * '−' characters as icons, 36–42px targets and no disabled distinction
 * on the buttons. This one uses real minus/plus glyphs, 44px targets,
 * and an optional editable centre.
 *
 * THE WHOLE CONTROL IS AN LTR ISLAND (direction:'ltr'): it is numeric —
 * decrement sits visually left of the value and increment right, exactly
 * as the digits themselves read, regardless of the Arabic layout around
 * it. tabular-nums keeps the value from wobbling as digits change.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import type {KeyboardTypeOptions} from 'react-native';

import {Icon} from '../../icons';
import {colors, radii, typography} from '../../theme';
import {MIN_TOUCH_TARGET, readInteraction} from './interaction';

export interface StepperProps {
  /** Display text for the current value. */
  value: string;
  onDecrement: () => void;
  onIncrement: () => void;
  /** Independent bound-state so "at minimum" only dims the − side. */
  decrementDisabled?: boolean;
  incrementDisabled?: boolean;
  /** Disables the whole control (both buttons and the input). */
  disabled?: boolean;
  /** When provided, the centre becomes an editable numeric TextInput. */
  onChangeText?: (text: string) => void;
  keyboardType?: KeyboardTypeOptions;
  /** Labels the value for screen readers, e.g. the setting name. */
  accessibilityLabel: string;
  /** Identifies the VALUE; the buttons derive `${testID}-minus`/`-plus`. */
  testID?: string;
  /** Override the derived button ids where a screen already published a
   * different naming to its tests (e.g. `-decrement`/`-increment`). */
  decrementTestID?: string;
  incrementTestID?: string;
}

export function Stepper({
  value,
  onDecrement,
  onIncrement,
  decrementDisabled = false,
  incrementDisabled = false,
  disabled = false,
  onChangeText,
  keyboardType = 'number-pad',
  accessibilityLabel,
  testID,
  decrementTestID,
  incrementTestID,
}: StepperProps): React.JSX.Element {
  const minusDisabled = disabled || decrementDisabled;
  const plusDisabled = disabled || incrementDisabled;
  const buttonTestID = (kind: 'minus' | 'plus'): string | undefined => {
    const override = kind === 'minus' ? decrementTestID : incrementTestID;
    if (override !== undefined) {
      return override;
    }
    return testID ? `${testID}-${kind}` : undefined;
  };

  const renderStepButton = (
    kind: 'minus' | 'plus',
    onPress: () => void,
    isDisabled: boolean,
  ) => (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${kind === 'minus' ? 'إنقاص' : 'زيادة'}`}
      accessibilityState={{disabled: isDisabled}}
      testID={buttonTestID(kind)}
      style={state => {
        const {pressed, hovered} = readInteraction(state);
        return [
          styles.stepButton,
          kind === 'minus' ? styles.stepButtonStart : styles.stepButtonEnd,
          hovered && !isDisabled && styles.stepHovered,
          pressed && !isDisabled && styles.stepPressed,
          isDisabled && styles.stepDisabled,
        ];
      }}>
      <Icon
        name={kind}
        size={20}
        color={isDisabled ? colors.textMuted : colors.accentStrong}
      />
    </Pressable>
  );

  return (
    <View style={styles.row}>
      {renderStepButton('minus', onDecrement, minusDisabled)}
      {onChangeText ? (
        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={!disabled}
          keyboardType={keyboardType}
          selectTextOnFocus
          accessibilityLabel={accessibilityLabel}
          style={[styles.value, styles.valueInput, disabled && styles.valueDisabled]}
          testID={testID}
        />
      ) : (
        <Text
          accessibilityLabel={`${accessibilityLabel}: ${value}`}
          style={[styles.value, disabled && styles.valueDisabled]}
          testID={testID}>
          {value}
        </Text>
      )}
      {renderStepButton('plus', onIncrement, plusDisabled)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: MIN_TOUCH_TARGET + 2,
    direction: 'ltr',
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  stepButton: {
    width: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backgroundRaised,
  },
  stepButtonStart: {
    borderRightWidth: 1,
    borderRightColor: colors.borderSoft,
  },
  stepButtonEnd: {
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSoft,
  },
  stepHovered: {backgroundColor: colors.surfaceHover},
  stepPressed: {backgroundColor: colors.surfacePressed},
  stepDisabled: {backgroundColor: colors.surfaceAlt},
  value: {
    ...typography.value,
    flex: 1,
    minWidth: 64,
    textAlign: 'center',
    textAlignVertical: 'center',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
    paddingVertical: 8,
  },
  valueInput: {
    paddingVertical: 0,
  },
  valueDisabled: {color: colors.textMuted},
});
