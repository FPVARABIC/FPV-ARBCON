/**
 * THE PERSISTENT BOTTOM TAB BAR.
 *
 * STICKY BY STRUCTURE, NOT BY OVERLAY. The bar is a sibling of the screen
 * content inside a flex column, so it occupies its own space at the bottom
 * of the window and is physically outside every screen's inner
 * ScrollView. No absolute positioning, no z-index, and nothing a screen
 * can scroll it behind or under.
 *
 * ONLY WORKING DESTINATIONS ARE VISIBLE. Every current product destination
 * is implemented; the filter remains fail-closed if a future roadmap entry
 * is added before its screen exists.
 *
 * RTL. Tabs retain MAIN_TABS product order and land right-to-left under
 * the app's `forceRTL`.
 *
 * IT OWNS NO STATE AND NO SESSION. It reports a press and nothing else.
 * Which tab is active, whether a tab change is permitted, and what a tab
 * change must stop are all decided by the shell above it.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import { MAIN_TABS, type MainTabKey } from '../../../navigation/tabs';

/** Minimum touch target, matching the rest of the app's controls. */
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
  MODES: '⌘',
  FAILSAFE: '⚠',
  POWER: 'ϟ',
  OSD: '▣',
  VTX: '⌁',
  SENSORS: '⌁',
  PRESETS: '✦',
  CLI: '>_',
};

export interface BottomTabBarProps {
  readonly activeTab: MainTabKey;
  readonly onSelectTab: (tab: MainTabKey) => void;
}

export default function BottomTabBar({
  activeTab,
  onSelectTab,
}: BottomTabBarProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <View
      style={styles.bar}
      accessibilityRole="tablist"
      accessibilityLabel={t('tabs.barAccessibilityLabel')}
      testID="main-tab-bar"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        testID="main-tab-bar-scroll"
      >
        {VISIBLE_TABS.map(tab => {
          const isActive = tab.key === activeTab;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onSelectTab(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive, disabled: false }}
              style={[styles.tab, isActive && styles.tabActive]}
              testID={`main-tab-${tab.key}`}
            >
              <View
                style={[styles.iconBubble, isActive && styles.iconBubbleActive]}
              >
                <Text style={[styles.icon, isActive && styles.iconActive]}>
                  {TAB_ICON[tab.key]}
                </Text>
              </View>
              <Text style={[styles.label, isActive && styles.labelActive]}>
                {t(tab.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.accent,
    borderTopWidth: 1,
    borderTopColor: colors.accentStrong,
    paddingTop: spacing.sm,
  },
  strip: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    minWidth: '100%',
  },
  tab: {
    flexGrow: 1,
    minWidth: 104,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
  },
  tabActive: {
    backgroundColor: colors.white,
  },
  iconBubble: {
    width: 30,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  iconBubbleActive: {
    backgroundColor: colors.accent,
  },
  icon: {
    fontSize: 15,
    color: colors.textPrimary,
    writingDirection: 'ltr',
  },
  iconActive: {
    color: colors.accentText,
  },
  label: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  labelActive: {
    color: colors.accentStrong,
  },
});
