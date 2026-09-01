/**
 * The numeric stepper — the − [value] + control.
 *
 * Two screens (PowerBattery, PidTuning) had drawn their own with typed
 * '−' characters as icons, 36–42px targets and no disabled distinction
 * on the buttons. This one uses real minus/plus glyphs, 44px targets,
 * and an optional editable centre.
 *
 * LAYOUT DIRECTION FOLLOWS THE SURROUNDING UI; THE VALUE TEXT DOES NOT.
 * An earlier version set `direction: 'ltr'` on the control to force
 * decrement-left/increment-right, but react-native-web rejects that
 * property outright ("Invalid style property of 'direction'"), so it
 * applied on Android and did nothing in the browser — the two platforms
 * disagreed. Button order therefore follows the ambient direction, which
 * is consistent on both: in this Arabic UI decrement sits at the reading
 * start.
 *
 * The value itself is a different question and gets the opposite answer.
 * "4.45 V" is a number and its unit, and inside a right-to-left box those
 * are two runs that swap into "V 4.45". The value style therefore
 * declares `writingDirection: 'ltr'` — the property react-native-web does
 * support, and the one that maps to CSS `direction` on web and to the
 * platform text direction on Android. tabular-nums keeps the value from
 * wobbling as the digits change.
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
    /**
     * INTRINSIC MINIMUM: two 44dp targets plus the value's own 64dp
     * floor. Without it the row silently overflowed a narrower parent and
     * its buttons landed ON TOP of the neighbouring field's buttons -
     * measured on PID, where the '+' of Roll P and the '-' of Roll I
     * overlapped by 17px, so a press near the seam hit the wrong value.
     * Declaring the minimum makes a wrapping parent wrap instead.
     */
    minWidth: MIN_TOUCH_TARGET * 2 + 64,
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
    /* THE TEXT is left-to-right even though the CONTROL follows the
       ambient direction. A value carries its unit after the number -
       "4.45 V", "450 mAh", "-100 dBm" - and that pairing is engineering
       notation, not prose. Read inside a right-to-left box the number and
       the unit are separate runs, so they swap: "V 4.45". This only
       affects the value text; the buttons keep following the layout. */
    writingDirection: 'ltr',
  },
  valueInput: {
    paddingVertical: 0,
  },
  valueDisabled: {color: colors.textMuted},
});
