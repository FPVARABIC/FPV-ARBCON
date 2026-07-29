/**
 * THE PERSISTENT BOTTOM TAB BAR.
 *
 * STICKY BY STRUCTURE, NOT BY OVERLAY. The bar is a sibling of the screen
 * content inside a flex column, so it occupies its own space at the bottom
 * of the window and is physically outside every screen's inner
 * ScrollView. No absolute positioning, no z-index, and nothing a screen
 * can scroll it behind or under.
 *
 * HORIZONTALLY SCROLLABLE, NEVER TRUNCATED. There are more tabs than fit
 * on a 390pt screen, so the strip itself scrolls. Labels are laid out at
 * their natural width with no `numberOfLines` and no ellipsis: an Arabic
 * label clipped to "الم…" is worse than one the operator has to scroll to.
 *
 * RTL. Tabs are ordered right-to-left by MAIN_TABS and land that way under
 * the app's `forceRTL`. The initial scroll offset is computed explicitly
 * (see computeTabBarInitialScrollOffset) so the RIGHT edge is what the
 * operator sees first in either layout direction.
 *
 * IT OWNS NO STATE AND NO SESSION. It reports a press and nothing else.
 * Which tab is active, whether a tab change is permitted, and what a tab
 * change must stop are all decided by the shell above it.
 */

import React, {useCallback, useRef} from 'react';
import {
  I18nManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../../theme';
import {
  MAIN_TABS,
  computeTabBarInitialScrollOffset,
  type MainTabKey,
} from '../../../navigation/tabs';

/** Minimum touch target, matching the rest of the app's controls. */
const MIN_TOUCH_TARGET = 44;

export interface BottomTabBarProps {
  readonly activeTab: MainTabKey;
  readonly onSelectTab: (tab: MainTabKey) => void;
}

export default function BottomTabBar({
  activeTab,
  onSelectTab,
}: BottomTabBarProps): React.JSX.Element {
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);
  const layoutWidthRef = useRef(0);
  /** The initial position is applied ONCE. Re-applying it on every content
   * size change would yank the strip back under the operator's finger. */
  const initialOffsetAppliedRef = useRef(false);

  const applyInitialOffset = useCallback(
    (contentWidth: number) => {
      if (initialOffsetAppliedRef.current || layoutWidthRef.current === 0) {
        return;
      }
      initialOffsetAppliedRef.current = true;
      const x = computeTabBarInitialScrollOffset({
        contentWidth,
        layoutWidth: layoutWidthRef.current,
        isRTL: I18nManager.isRTL,
      });
      scrollRef.current?.scrollTo({x, y: 0, animated: false});
    },
    [],
  );

  return (
    <View
      style={[styles.bar, {paddingBottom: insets.bottom}]}
      accessibilityRole="tablist"
      accessibilityLabel={t('tabs.barAccessibilityLabel')}
      testID="main-tab-bar">
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onLayout={event => {
          layoutWidthRef.current = event.nativeEvent.layout.width;
        }}
        onContentSizeChange={applyInitialOffset}
        contentContainerStyle={styles.strip}
        testID="main-tab-bar-scroll">
        {MAIN_TABS.map(tab => {
          const isActive = tab.key === activeTab;
          const isDisabled = !tab.implemented;
          return (
            <Pressable
              key={tab.key}
              onPress={isDisabled ? undefined : () => onSelectTab(tab.key)}
              disabled={isDisabled}
              accessibilityRole="tab"
              accessibilityState={{selected: isActive, disabled: isDisabled}}
              style={[
                styles.tab,
                isActive && styles.tabActive,
                isDisabled && styles.tabDisabled,
              ]}
              testID={`main-tab-${tab.key}`}>
              <Text
                style={[
                  styles.label,
                  isActive && styles.labelActive,
                  isDisabled && styles.labelDisabled,
                ]}>
                {t(tab.labelKey)}
              </Text>
              {isDisabled ? (
                <Text style={styles.unavailable}>{t('tabs.unavailable')}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  strip: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  tab: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    // The active indicator is a border, not a colour swap alone - the same
    // never-colour-alone rule the safety banners follow.
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    backgroundColor: colors.surfaceAlt,
    borderBottomColor: colors.accent,
  },
  tabDisabled: {
    // No background: a disabled tab must not read as a pressable surface.
    borderBottomColor: 'transparent',
  },
  label: {
    ...typography.sectionTitle,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  labelActive: {
    color: colors.accent,
  },
  labelDisabled: {
    color: colors.disabled,
  },
  unavailable: {
    ...typography.caption,
    color: colors.disabled,
    writingDirection: 'rtl',
  },
});
