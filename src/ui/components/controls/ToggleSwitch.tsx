/**
 * The product's switch — replaces the platform Switch everywhere.
 *
 * WHY NOT react-native's <Switch/>: it renders the Android platform
 * control (small, theme-coloured by the OS) and a different, smaller
 * control under react-native-web — the exact "small and weak, different
 * on every screen" defect the audit recorded. This one draws itself, so
 * Android and the browser show the same 52×30 control with the same
 * unambiguous ON state.
 *
 * ON is the DEEP teal (accentStrong) with a white thumb — not the light
 * accent, which sits too close to the paper background to answer "is it
 * on?" at a glance. OFF is a bordered neutral track. The pressable box
 * is padded up to the 44px target floor even though the visible track
 * is 30 tall.
 *
 * RTL: the thumb position uses logical flex alignment, so ON sits at the
 * layout-correct end automatically — no isRTL branching.
 */
import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {colors} from '../../theme';
import {MIN_TOUCH_TARGET, readInteraction} from './interaction';

export interface ToggleSwitchProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
}

const TRACK_WIDTH = 52;
const TRACK_HEIGHT = 30;
const THUMB = 22;

export function ToggleSwitch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  testID,
}: ToggleSwitchProps): React.JSX.Element {
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{checked: value, disabled}}
      // BOTH state channels on purpose. Measured in a real browser:
      // react-native-web renders accessibilityState.checked as NOTHING,
      // so the switch reached the accessibility tree with a role and no
      // state — a screen reader announced "switch" and never "on"/"off".
      // The aria-* props are core React Native props (0.71+) and map
      // natively too, so this stays one component, not a web branch.
      aria-checked={value}
      aria-disabled={disabled}
      testID={testID}
      style={styles.target}>
      {state => {
        const {hovered, pressed} = readInteraction(state);
        return (
          <View
            style={[
              styles.track,
              value ? styles.trackOn : styles.trackOff,
              (hovered || pressed) && !disabled && styles.trackActive,
              disabled && styles.trackDisabled,
            ]}>
            <View
              style={[
                styles.thumb,
                value ? styles.thumbOn : styles.thumbOff,
                disabled && styles.thumbDisabled,
              ]}
            />
          </View>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  trackOff: {
    backgroundColor: colors.switchTrackOff,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  trackOn: {
    backgroundColor: colors.accentStrong,
    borderWidth: 1.5,
    borderColor: colors.accentStrong,
  },
  trackActive: {
    // A visible but quiet acknowledgment on hover/press for both states.
    borderColor: colors.accentText,
  },
  trackDisabled: {
    opacity: 0.45,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.white,
  },
  thumbOff: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  thumbOn: {
    alignSelf: 'flex-end',
  },
  thumbDisabled: {},
});
