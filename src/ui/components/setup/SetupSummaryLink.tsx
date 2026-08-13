/**
 * SETUP P2 - the ONE interaction language for every summary card.
 *
 * Before P2 exactly one of the four summary cards was pressable (GPS),
 * with an ad-hoc Pressable inline in SetupScreen. The other three looked
 * identical and did nothing, which taught the operator that these cards
 * are decoration. This wrapper gives all four the same affordance,
 * accessibility contract and RTL chevron, decided in one place.
 *
 * READ-ONLY BY CONSTRUCTION. It takes an `onPress` and a label and
 * nothing else: it cannot write, cannot reach a controller, and does not
 * know what screen it opens. Setup stays an overview that navigates to
 * owners; ownership of every configuration remains where it already is.
 *
 * NOT INTERACTIVE WHEN THERE IS NOWHERE TO GO. With no `onPress` the
 * card renders as a plain container with no button role, no chevron and
 * no press feedback - a decorative area must never look tappable.
 */

import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {Icon} from '../../icons';
import {readInteraction} from '../controls/interaction';
import {colors, radii, spacing, typography} from '../../theme';

/** Android's minimum recommended touch target. */
const MIN_TOUCH_TARGET = 44;

export interface SetupSummaryLinkProps {
  /** Undefined = this card has no owner screen to open right now. */
  onPress?: () => void;
  /** Complete Arabic sentence, e.g. "فتح شاشة جهاز الاستقبال". Read
   * INSTEAD of the card body by assistive technology, so it must name
   * the destination rather than describe the chevron. */
  accessibilityLabel: string;
  testID: string;
  children: React.ReactNode;
}

export default function SetupSummaryLink({
  onPress,
  accessibilityLabel,
  testID,
  children,
}: SetupSummaryLinkProps): React.JSX.Element {
  if (onPress === undefined) {
    return (
      <View style={styles.plain} testID={`${testID}-static`}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={state => {
        const {pressed, hovered} = readInteraction(state);
        return [styles.press, (hovered || pressed) && styles.pressActive];
      }}
      testID={testID}
    >
      {children}
      {/* The affordance row. `chevron-forward` is the DIRECTION-aware
          name (Icon.tsx), so it points the way the reader travels in
          both Arabic and LTR rather than being hard-coded to one side. */}
      <View style={styles.affordance}>
        <Text style={styles.affordanceText}>{OPEN_HINT}</Text>
        <Icon name="chevron-forward" size={18} color={colors.accentStrong} />
      </View>
    </Pressable>
  );
}

/* A single shared word, not a per-card string: every one of these cards
 * does the same thing, and four translations of "open" would be four
 * chances to drift. The destination itself is carried by the
 * accessibility label above, which is per-card. */
const OPEN_HINT = 'فتح';

const styles = StyleSheet.create({
  /* Radius matches the card it wraps so the hover wash cannot bleed
     past the corners. */
  press: {
    borderRadius: radii.lg,
    minHeight: MIN_TOUCH_TARGET,
  },
  pressActive: {backgroundColor: colors.surfaceHover},
  plain: {borderRadius: radii.lg},
  affordance: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
    paddingTop: 2,
  },
  affordanceText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '600',
  },
});
