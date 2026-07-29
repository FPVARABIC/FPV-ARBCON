/**
 * Bottom tab bar - order, RTL scroll position, disabled state and the
 * Motors stop guard.
 *
 * NO HARDWARE. Nothing here opens a session or touches USB.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import React from 'react';
import {I18nManager, ScrollView} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../../i18n';
import i18n from '../../../i18n';
import BottomTabBar from './BottomTabBar';
import {
  MAIN_TABS,
  computeTabBarInitialScrollOffset,
  isTabSelectable,
  type MainTabKey,
} from '../../../navigation/tabs';

function renderBar(onSelectTab: (tab: MainTabKey) => void = () => {}) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <BottomTabBar activeTab="SETUP" onSelectTab={onSelectTab} />,
    );
  });
  return {
    renderer,
    find: (testID: string) => renderer.root.findAllByProps({testID})[0],
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

describe('BottomTabBar - order and labels', () => {
  it('renders all five tabs in right-to-left product order', () => {
    const rendered = renderBar();
    const order = rendered.renderer.root
      .findAllByProps({}, {deep: true})
      .map(node => node.props.testID)
      .filter(
        (testID: unknown): testID is string =>
          typeof testID === 'string' && testID.startsWith('main-tab-'),
      )
      .filter(testID => testID !== 'main-tab-bar' && testID !== 'main-tab-bar-scroll');
    const firstIndex = (key: string) => order.indexOf(`main-tab-${key}`);
    // Emission order IS right-to-left order: the first child of a
    // `flexDirection: 'row'` container sits at the right edge under RTL.
    expect(firstIndex('SETUP')).toBeLessThan(firstIndex('MOTORS'));
    expect(firstIndex('MOTORS')).toBeLessThan(firstIndex('PORTS'));
    expect(firstIndex('PORTS')).toBeLessThan(firstIndex('RECEIVER'));
    expect(firstIndex('RECEIVER')).toBeLessThan(firstIndex('PID'));
    rendered.unmount();
  });

  it('labels every tab from the Arabic catalogue, never a hard-coded string', () => {
    const rendered = renderBar();
    const texts = rendered.renderer.root
      .findAllByType('Text' as never, {deep: true})
      .flatMap(node =>
        (Array.isArray(node.props.children)
          ? node.props.children
          : [node.props.children]
        ).filter((child: unknown) => typeof child === 'string'),
      );
    expect(texts).toContain(i18n.t('tabs.setup'));
    expect(texts).toContain(i18n.t('tabs.motors'));
    expect(texts).toContain(i18n.t('tabs.ports'));
    expect(texts).toContain(i18n.t('tabs.receiver'));
    expect(texts).toContain(i18n.t('tabs.pid'));
    // A raw key rendered on screen is the exact defect this whole pass
    // exists to remove.
    for (const tab of MAIN_TABS) {
      expect(texts).not.toContain(tab.labelKey);
    }
    rendered.unmount();
  });

  it('never truncates a label', () => {
    const rendered = renderBar();
    for (const node of rendered.renderer.root.findAllByType('Text' as never, {
      deep: true,
    })) {
      expect(node.props.numberOfLines).toBeUndefined();
      expect(node.props.ellipsizeMode).toBeUndefined();
    }
    rendered.unmount();
  });
});

describe('BottomTabBar - disabled roadmap tabs', () => {
  it('renders unimplemented tabs visibly disabled rather than hiding them', () => {
    const pressed: MainTabKey[] = [];
    const rendered = renderBar(tab => pressed.push(tab));
    for (const tab of MAIN_TABS) {
      const node = rendered.find(`main-tab-${tab.key}`);
      expect(node).toBeDefined();
      expect(node.props.accessibilityState.disabled).toBe(!tab.implemented);
      if (!tab.implemented) {
        // No press handler at all - not merely a handler that no-ops.
        expect(node.props.onPress).toBeUndefined();
      }
    }
    expect(isTabSelectable('PORTS')).toBe(false);
    expect(isTabSelectable('RECEIVER')).toBe(false);
    expect(isTabSelectable('PID')).toBe(false);
    expect(pressed).toEqual([]);
    rendered.unmount();
  });

  it('marks the active tab as selected', () => {
    const rendered = renderBar();
    expect(
      rendered.find('main-tab-SETUP').props.accessibilityState.selected,
    ).toBe(true);
    expect(
      rendered.find('main-tab-MOTORS').props.accessibilityState.selected,
    ).toBe(false);
    rendered.unmount();
  });
});

describe('BottomTabBar - safe area and stickiness', () => {
  it('pads the bottom by the gesture-navigation inset', () => {
    const rendered = renderBar();
    const bar = rendered.find('main-tab-bar');
    const style = Array.isArray(bar.props.style)
      ? Object.assign({}, ...bar.props.style.filter(Boolean))
      : bar.props.style;
    expect(style.paddingBottom).toBe(34);
    rendered.unmount();
  });

  it('scrolls horizontally rather than compressing the strip', () => {
    const rendered = renderBar();
    const scroll = rendered.renderer.root.findByType(ScrollView);
    expect(scroll.props.horizontal).toBe(true);
    rendered.unmount();
  });
});

describe('Initial scroll position is the RIGHT edge', () => {
  it('lands on the right edge in an RTL layout', () => {
    // Android mirrors the horizontal scroll coordinate space under RTL:
    // offset 0 IS the right edge.
    expect(
      computeTabBarInitialScrollOffset({
        contentWidth: 720,
        layoutWidth: 390,
        isRTL: true,
      }),
    ).toBe(0);
  });

  it('lands on the right edge in an LTR layout too, so a mirrored preview is not mistaken for correct', () => {
    expect(
      computeTabBarInitialScrollOffset({
        contentWidth: 720,
        layoutWidth: 390,
        isRTL: false,
      }),
    ).toBe(330);
  });

  it('clamps to zero when the strip fits', () => {
    for (const isRTL of [true, false]) {
      expect(
        computeTabBarInitialScrollOffset({
          contentWidth: 300,
          layoutWidth: 390,
          isRTL,
        }),
      ).toBe(0);
    }
  });

  it('applies the computed offset exactly once, on first content layout', () => {
    const rendered = renderBar();
    const scroll = rendered.renderer.root.findByType(ScrollView);
    const calls: {x: number; animated?: boolean}[] = [];
    (scroll.instance as {scrollTo: unknown}).scrollTo = (
      options: {x: number; animated?: boolean},
    ) => {
      calls.push(options);
    };
    ReactTestRenderer.act(() => {
      scroll.props.onLayout({nativeEvent: {layout: {width: 390, height: 60}}});
    });
    ReactTestRenderer.act(() => {
      scroll.props.onContentSizeChange(720, 60);
    });
    ReactTestRenderer.act(() => {
      scroll.props.onContentSizeChange(760, 60);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].x).toBe(
      computeTabBarInitialScrollOffset({
        contentWidth: 720,
        layoutWidth: 390,
        isRTL: I18nManager.isRTL,
      }),
    );
    expect(calls[0].animated).toBe(false);
    rendered.unmount();
  });
});
