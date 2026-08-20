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

import {colors, radii, spacing, typography} from '../../theme';
import { Icon } from '../../icons';
import { MIN_TOUCH_TARGET, readInteraction } from '../controls/interaction';
import { MAIN_TABS, type MainTabKey } from '../../../navigation/tabs';
import { TAB_ICONS } from './tabIcons';
import { useActiveItemReveal } from './activeItemReveal';

const VISIBLE_TABS = MAIN_TABS.filter(tab => tab.implemented);

export interface BottomTabBarProps {
  readonly activeTab: MainTabKey;
  readonly onSelectTab: (tab: MainTabKey) => void;
}

export default function BottomTabBar({
  activeTab,
  onSelectTab,
}: BottomTabBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const reveal = useActiveItemReveal<MainTabKey>(activeTab, 'x');

  return (
    <View
      style={styles.bar}
      accessibilityRole="tablist"
      accessibilityLabel={t('tabs.barAccessibilityLabel')}
      testID="main-tab-bar"
    >
      <ScrollView
        ref={reveal.scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        onLayout={reveal.onScrollViewLayout}
        onContentSizeChange={reveal.onContentSizeChange}
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
              style={state => {
                const { pressed, hovered } = readInteraction(state);
                return [
                  styles.tab,
                  (hovered || pressed) && !isActive && styles.tabPressed,
                  isActive && styles.tabActive,
                ];
              }}
              onLayout={reveal.registerItem(tab.key)}
              testID={`main-tab-${tab.key}`}
            >
              <View
                style={[styles.iconBubble, isActive && styles.iconBubbleActive]}
              >
                <Icon
                  name={TAB_ICONS[tab.key]}
                  size={18}
                  color={isActive ? colors.accentText : colors.textPrimary}
                />
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
    /**
     * NOTHING HERE MAY PIN THE MAIN AXIS. This is a horizontal
     * ScrollView's content container, and Android derives the scrollable
     * range from this view's own measured width
     * (HorizontalScrollView.computeHorizontalScrollRange(), used by
     * ReactHorizontalScrollView as `range - getWidth()`). It previously
     * carried `width: '100%'`, `minWidth: '100%'` and `maxWidth: 1180`,
     * which pinned it to the viewport: measured in Chromium at 390px the
     * content box was exactly 390 while the fifteen destinations need
     * 1705, so on Android the range was 390-390 = 0 - the strip could not
     * be scrolled at all and TWELVE destinations were unreachable. The
     * browser hid the defect because CSS scrollable overflow still counts
     * overflowing flex children, so scrollWidth read 1705 there.
     *
     * `flexGrow` fills the bar when the destinations happen to fit and
     * lets the container exceed the viewport when they do not, which is
     * the behaviour the pinned width was reaching for.
     */
    flexGrow: 1,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
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
  tabPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.45)',
  },
  tabActive: {
    backgroundColor: colors.white,
  },
  iconBubble: {
    width: 34,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  iconBubbleActive: {
    backgroundColor: colors.accent,
  },
  label: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  labelActive: {
    color: colors.accentStrong,
  },
});
