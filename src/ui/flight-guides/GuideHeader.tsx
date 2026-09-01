/**
 * The bar at the top of the two guide screens.
 *
 * SHARED CHROME IS NOT SHARED CONTENT. This component carries a back
 * control and whatever title it is handed; it knows nothing about any
 * flight style and holds no value, number or recommendation. The rule the
 * package is built on - code may be shared, guidance may not - is about
 * what the reader is shown, and two screens agreeing on where the back
 * button sits is the opposite of a problem.
 *
 * The layout matches the flasher's own header (eyebrow above title, back
 * control at the reading start) so entering a guide does not feel like
 * entering a different application.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {Icon} from '../icons';
import {readInteraction} from '../components/controls/interaction';
import {colors, radii, spacing, typography} from '../theme';

export function GuideHeader({
  eyebrow,
  title,
  onBack,
  testID,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly onBack: () => void;
  readonly testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.header} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="العودة"
        onPress={onBack}
        testID="guide-back"
        style={state => {
          const {pressed, hovered} = readInteraction(state);
          return [styles.back, hovered && styles.backHovered, pressed && styles.backPressed];
        }}>
        <Icon name="chevron-back" size={24} color={colors.textPrimary} />
      </Pressable>
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  back: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backHovered: {backgroundColor: colors.surfaceHover},
  backPressed: {backgroundColor: colors.surfacePressed},
  copy: {flex: 1},
  eyebrow: {...typography.eyebrow, color: colors.accentStrong, textAlign: 'right'},
  title: {...typography.title, color: colors.textPrimary, textAlign: 'right'},
});
