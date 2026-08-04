/**
 * THE DESKTOP NAVIGATION RAIL.
 *
 * WHY IT EXISTS. A bottom tab bar is a phone idiom. On a 1920px monitor
 * it puts the primary navigation as far from the operator's eyes as the
 * window allows and wastes the horizontal room a configurator needs. The
 * operator reported the post-connection screens as "a mobile phone
 * interface inside a desktop monitor"; this is the navigation half of the
 * answer.
 *
 * IT IS THE SAME NAVIGATION, NOT A SECOND ONE. Identical props to
 * BottomTabBar, identical MAIN_TABS order, identical
 * implemented-only filtering, identical "reports a press and nothing
 * else" contract. The shell renders exactly one of the two for a given
 * width - it never mounts, unmounts or reorders any tab PANEL, which is
 * the invariant MainTabsScreen's motor-stop bridge depends on.
 *
 * RTL. The rail sits on the right under the app's forceRTL, which is the
 * reading-order start.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import { MAIN_TABS, type MainTabKey } from '../../../navigation/tabs';

const MIN_TOUCH_TARGET = 44;
const VISIBLE_TABS = MAIN_TABS.filter(tab => tab.implemented);
const TAB_ICON: Record<MainTabKey, string> = {
  SETUP: '⌁',
  MOTORS: '◉',
  PORTS: '↔',
  GPS: '⌖',
  CONFIGURATIONS: '⚙',
  RECEIVER: '⌁',
  PID: '∿',
};

/** Wide enough for the longest Arabic destination label at 100% text
 * scale without wrapping, and narrow enough to leave the workspace the
 * majority of a 1280px window. */
export const SIDE_RAIL_WIDTH = 208;

export interface SideNavigationRailProps {
  readonly activeTab: MainTabKey;
  readonly onSelectTab: (tab: MainTabKey) => void;
  /** Optional connection/identity strip shown above the destinations. */
  readonly header?: React.ReactNode;
}

export default function SideNavigationRail({
  activeTab,
  onSelectTab,
  header,
}: SideNavigationRailProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <View
      style={styles.rail}
      accessibilityRole="tablist"
      accessibilityLabel={t('tabs.barAccessibilityLabel')}
      testID="main-side-rail"
    >
      {header !== undefined ? (
        <View style={styles.header} testID="main-side-rail-header">
          {header}
        </View>
      ) : null}
      <View style={styles.list}>
        {VISIBLE_TABS.map(tab => {
          const isActive = tab.key === activeTab;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onSelectTab(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive, disabled: false }}
              style={[styles.item, isActive && styles.itemActive]}
              testID={`main-rail-${tab.key}`}
            >
              <View
                style={[styles.iconBubble, isActive && styles.iconBubbleActive]}
              >
                <Text style={[styles.icon, isActive && styles.iconActive]}>
                  {TAB_ICON[tab.key]}
                </Text>
              </View>
              <Text
                style={[styles.label, isActive && styles.labelActive]}
                numberOfLines={1}
              >
                {t(tab.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: SIDE_RAIL_WIDTH,
    backgroundColor: colors.backgroundRaised,
    borderStartWidth: 1,
    borderStartColor: colors.borderSoft,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    gap: spacing.md,
  },
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  list: { gap: spacing.xs },
  item: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
  },
  itemActive: { backgroundColor: colors.accentSoft },
  iconBubble: {
    width: 30,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  iconBubbleActive: { backgroundColor: colors.accent },
  icon: { fontSize: 15, color: colors.textMuted, writingDirection: 'ltr' },
  iconActive: { color: colors.accentText },
  label: {
    ...typography.body,
    flex: 1,
    fontWeight: '700',
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  labelActive: { color: colors.accent },
});
