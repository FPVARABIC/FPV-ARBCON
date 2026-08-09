/**
 * THE NAVIGATION COULD NOT BE SCROLLED ON ANDROID.
 *
 * Fifteen destinations do not fit. Both navigation surfaces put them in a
 * ScrollView, and on the real APK neither one moved: the entries past the
 * edge were clipped and simply could not be reached.
 *
 * TWO INDEPENDENT CAUSES, both of them "the scroll container's measured
 * size equals its content, so the platform computes a range of zero", and
 * both invisible in a browser:
 *
 *  1. BOTTOM TAB BAR - the contentContainerStyle carried `width: '100%'`,
 *     `minWidth: '100%'` and `maxWidth: 1180`, pinning the content
 *     container to the viewport. Android takes its scroll range from that
 *     view's own width (HorizontalScrollView.computeHorizontalScrollRange,
 *     used by ReactHorizontalScrollView as `range - getWidth()`), so the
 *     range was 390-390 = 0. The browser hid it because CSS scrollable
 *     overflow still counts overflowing flex children.
 *
 *  2. SIDE RAIL - the ScrollView had no flex style, and React Native's
 *     Yoga default is `flexShrink: 0` (yoga Style.h,
 *     `DefaultFlexShrink = 0.0f`), so it took its full content height,
 *     overflowed the rail and again reported a zero range. CSS defaults
 *     `flex-shrink` to 1, which is why the browser scrolled correctly.
 *
 * A third gap: nothing revealed the ACTIVE destination, and the tab can
 * change programmatically (Setup's GPS card, Configurations' shortcuts,
 * every screen's "open Motors"), so an operator could land on a screen
 * whose navigation entry was scrolled out of sight.
 *
 * THE GEOMETRY BELOW IS MEASURED, NOT INVENTED - taken from the real
 * components rendered in Chromium at 390x768 and 1366x768. Jest has no
 * layout engine, so feeding the real numbers through the real handlers is
 * what makes these assertions mean anything.
 *
 * NO HARDWARE. Nothing here opens a session or touches USB.
 */

import React from 'react';
import {ScrollView} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../../i18n';
import BottomTabBar from './BottomTabBar';
import SideNavigationRail from './SideNavigationRail';
import {computeRevealOffset} from './activeItemReveal';
import {horizontalScrollOffset} from './scrollOffset';
import type {MainTabKey} from '../../../navigation/tabs';

/**
 * The tab strip as it really lays out at 390x768, under RTL: SETUP is the
 * first child and therefore sits at the RIGHT edge (largest x), CLI at the
 * left. Content 1723 against a 390 viewport - 1333px that could not be
 * reached before this fix.
 */
const BAR = {
  viewport: 390,
  content: 1723,
  items: [
    {key: 'SETUP', x: 1601, w: 104},
    {key: 'MOTORS', x: 1489, w: 104},
    {key: 'PORTS', x: 1377, w: 104},
    {key: 'GPS', x: 1265, w: 104},
    {key: 'CONFIGURATIONS', x: 1153, w: 104},
    {key: 'RECEIVER', x: 1041, w: 104},
    {key: 'PID', x: 929, w: 104},
    {key: 'MODES', x: 817, w: 104},
    {key: 'FAILSAFE', x: 705, w: 104},
    {key: 'POWER', x: 578, w: 119},
    {key: 'OSD', x: 466, w: 104},
    {key: 'VTX', x: 354, w: 104},
    {key: 'SENSORS', x: 242, w: 104},
    {key: 'PRESETS', x: 130, w: 104},
    {key: 'CLI', x: 18, w: 104},
  ],
} as const;

/** The rail at 1366x768: fifteen 44dp rows with 4dp gaps = 716 of content
 * in a 672 viewport. */
const RAIL = {
  viewport: 672,
  content: 716,
  items: BAR.items.map((item, index) => ({
    key: item.key,
    y: index * 48,
    h: 44,
  })),
} as const;

const noop = () => {};

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

/**
 * Spies the exact method the components call. Under the React Native Jest
 * preset a ScrollView ref is a `ScrollViewMock` instance whose `scrollTo`
 * lives on the shared prototype.
 */
function spyOnScrollTo() {
  const prototype = (
    ScrollView as unknown as {
      prototype: {scrollTo: (options: {x?: number; y?: number}) => void};
    }
  ).prototype;
  return jest.spyOn(prototype, 'scrollTo');
}

function lastScroll(
  spy: ReturnType<typeof spyOnScrollTo>,
): {x?: number; y?: number} {
  const call = spy.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('scrollTo was never called');
  }
  return call[0];
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('every destination can be brought into view', () => {
  it('reveals each tab fully inside the strip viewport, for all fifteen', () => {
    // THE REACHABILITY PROPERTY, stated directly: for every destination
    // there is an offset within the scrollable range that puts the whole
    // entry inside the viewport. Before the fix the range was zero, so
    // this was false for twelve of them at 390px.
    const maxOffset = BAR.content - BAR.viewport;
    for (const item of BAR.items) {
      const offset = computeRevealOffset({
        itemStart: item.x,
        itemSize: item.w,
        viewportSize: BAR.viewport,
        contentSize: BAR.content,
      });
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(maxOffset);
      expect(item.x).toBeGreaterThanOrEqual(offset);
      expect(item.x + item.w).toBeLessThanOrEqual(offset + BAR.viewport);
    }
  });

  it('reveals each rail row fully inside the rail viewport, for all fifteen', () => {
    const maxOffset = RAIL.content - RAIL.viewport;
    for (const item of RAIL.items) {
      const offset = computeRevealOffset({
        itemStart: item.y,
        itemSize: item.h,
        viewportSize: RAIL.viewport,
        contentSize: RAIL.content,
      });
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(maxOffset);
      expect(item.y).toBeGreaterThanOrEqual(offset);
      expect(item.y + item.h).toBeLessThanOrEqual(offset + RAIL.viewport);
    }
  });

  it('asks for no scrolling at all when everything already fits', () => {
    expect(
      computeRevealOffset({
        itemStart: 0,
        itemSize: 104,
        viewportSize: 900,
        contentSize: 400,
      }),
    ).toBe(0);
  });
});

describe('BottomTabBar - the strip can actually scroll', () => {
  it('never pins its content container to the viewport on the scroll axis', () => {
    // THE ROOT CAUSE, guarded directly. Any width/minWidth/maxWidth here
    // makes Android's computeHorizontalScrollRange equal to the viewport,
    // which is a scroll range of zero however many tabs overflow.
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <BottomTabBar activeTab="SETUP" onSelectTab={noop} />,
      );
    });
    const strip = flatten(
      renderer.root.findAllByProps({testID: 'main-tab-bar-scroll'})[0].props
        .contentContainerStyle,
    );
    expect(strip.width).toBeUndefined();
    expect(strip.minWidth).toBeUndefined();
    expect(strip.maxWidth).toBeUndefined();
    // ...and it still fills the bar when the destinations do happen to fit.
    expect(strip.flexGrow).toBe(1);
    act(() => renderer.unmount());
  });

  it('scrolls a destination that is off-screen into view when it becomes active', () => {
    const spy = spyOnScrollTo();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <BottomTabBar activeTab="SETUP" onSelectTab={noop} />,
      );
    });
    const scroll = renderer.root.findAllByProps({
      testID: 'main-tab-bar-scroll',
    })[0];
    act(() => {
      scroll.props.onLayout({
        nativeEvent: {layout: {x: 0, y: 0, width: BAR.viewport, height: 58}},
      });
      scroll.props.onContentSizeChange(BAR.content, 58);
      for (const item of BAR.items) {
        renderer.root
          .findAllByProps({testID: `main-tab-${item.key}`})[0]
          .props.onLayout({
            nativeEvent: {layout: {x: item.x, y: 0, width: item.w, height: 58}},
          });
      }
    });

    spy.mockClear();
    // CLI is the far end of the strip - 1333px outside a 390px viewport.
    act(() => {
      renderer.update(<BottomTabBar activeTab="CLI" onSelectTab={noop} />);
    });

    const cli = BAR.items[BAR.items.length - 1];
    expect(cli.key).toBe('CLI');
    const offset = lastScroll(spy).x;
    expect(offset).toBeDefined();
    // Natively the offset is left-origin, so it can be compared with the
    // laid-out geometry directly.
    expect(cli.x).toBeGreaterThanOrEqual(offset as number);
    expect(cli.x + cli.w).toBeLessThanOrEqual((offset as number) + BAR.viewport);
    act(() => renderer.unmount());
  });

  it('still routes a press on an off-screen destination to that destination', () => {
    // Reaching a tab must select the tab it is labelled with - the scroll
    // fix must not have shifted which entry answers a press.
    const picked: MainTabKey[] = [];
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <BottomTabBar activeTab="SETUP" onSelectTab={tab => picked.push(tab)} />,
      );
    });
    act(() => {
      renderer.root.findAllByProps({testID: 'main-tab-CLI'})[0].props.onPress();
      renderer.root
        .findAllByProps({testID: 'main-tab-SENSORS'})[0]
        .props.onPress();
    });
    expect(picked).toEqual(['CLI', 'SENSORS']);
    act(() => renderer.unmount());
  });
});

describe('SideNavigationRail - the list can actually scroll', () => {
  it('lets its scroller shrink inside the rail instead of overflowing it', () => {
    // React Native does NOT default flexShrink to 1 the way CSS does, so
    // an unstyled ScrollView here grows to its content and reports no
    // scroll range at all. This is the declaration that prevents it.
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SideNavigationRail activeTab="SETUP" onSelectTab={noop} />,
      );
    });
    const style = flatten(
      renderer.root.findAllByProps({testID: 'main-side-rail-scroll'})[0].props
        .style,
    );
    expect(style.flex).toBe(1);
    act(() => renderer.unmount());
  });

  it('scrolls a row that is below the fold into view when it becomes active', () => {
    const spy = spyOnScrollTo();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <SideNavigationRail activeTab="SETUP" onSelectTab={noop} />,
      );
    });
    const scroll = renderer.root.findAllByProps({
      testID: 'main-side-rail-scroll',
    })[0];
    act(() => {
      scroll.props.onLayout({
        nativeEvent: {layout: {x: 0, y: 0, width: 191, height: RAIL.viewport}},
      });
      scroll.props.onContentSizeChange(191, RAIL.content);
      for (const item of RAIL.items) {
        renderer.root
          .findAllByProps({testID: `main-rail-${item.key}`})[0]
          .props.onLayout({
            nativeEvent: {layout: {x: 0, y: item.y, width: 191, height: item.h}},
          });
      }
    });

    spy.mockClear();
    act(() => {
      renderer.update(
        <SideNavigationRail activeTab="CLI" onSelectTab={noop} />,
      );
    });

    const cli = RAIL.items[RAIL.items.length - 1];
    const offset = lastScroll(spy).y;
    expect(offset).toBeDefined();
    expect(cli.y).toBeGreaterThanOrEqual(offset as number);
    expect(cli.y + cli.h).toBeLessThanOrEqual((offset as number) + RAIL.viewport);
    // The measured browser answer for exactly this geometry was 44.
    expect(offset).toBe(44);
    act(() => renderer.unmount());
  });
});

describe('the horizontal scroll coordinate handed to the platform', () => {
  it('is left-origin and unchanged on native', () => {
    // Android's View.scrollTo(x, y) is left-origin and non-negative even
    // under RTL; ReactHorizontalScrollView only converts to a right-origin
    // space internally, for snapping.
    expect(horizontalScrollOffset(0, 1333)).toBe(0);
    expect(horizontalScrollOffset(1333, 1333)).toBe(1333);
    expect(horizontalScrollOffset(640, 1333)).toBe(640);
  });
});
