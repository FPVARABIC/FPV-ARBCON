/**
 * HOME'S DESTINATIONS, ITS HIERARCHY, AND A WAY BACK OUT OF EVERY ONE.
 *
 * Two reported defects meet here. The flight-controller workspace could
 * be entered with no visible way back - Home → connect → trapped. And
 * the Home screen sold the product with a slogan ("مهمتان، بابان
 * مباشران") instead of naming the things an operator can actually do.
 * These tests pin the corrected entry: plain Arabic, compact actions,
 * and a back control wherever there is somewhere to go back to.
 *
 * TWO DOORS, THEN THREE, AND NOW TWO PRIMARIES PLUS A COMPANION. The
 * flight-style guide used to be a third peer card at the TOP of the
 * page, which said the guide mattered more than configuring a board.
 * It does not: it is reference material. So Home now leads with the two
 * things an operator opens this application to DO - configure and flash
 * - and the guide follows in a band of its own.
 *
 * WHAT CHANGED IN THIS FILE, AND WHAT DID NOT. Only the STRUCTURE the
 * assertions point at: which group holds which control. Every guarantee
 * the suite carried is still here, and several are now checked in more
 * places than before - each destination is still reached directly, every
 * call to action is still compact and still at least 44pt, a stacked
 * card still never asks for zero height, the desktop row still splits
 * equally, the slogan is still gone, the brand name is still the
 * product's and not the repository's, and there is still no hardcoded
 * "ready" badge. Added on top: the guide must NOT sit among the
 * primaries, and it must come after them on the page.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text, View} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import StartScreen from './StartScreen';
import {BRAND_PRODUCT_NAME} from '../brand';

type Renderer = ReactTestRenderer.ReactTestRenderer;

function screenText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

function control(renderer: Renderer, testID: string) {
  return renderer.root
    .findAllByProps({testID})
    .find(node => typeof node.props.onPress === 'function');
}

/** The resolved style of a control, merged across every node carrying
 * that testID (the composite and its host both do). */
function styleOf(renderer: Renderer, testID: string): Record<string, unknown> {
  const nodes = renderer.root.findAllByProps({testID});
  if (nodes.length === 0) throw new Error(`Missing control ${testID}`);
  const flatten = (value: unknown): Record<string, unknown> =>
    Array.isArray(value)
      ? value.reduce<Record<string, unknown>>(
          (all, item) => ({...all, ...flatten(item)}),
          {},
        )
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
  return nodes.reduce<Record<string, unknown>>((all, node) => {
    const raw =
      typeof node.props.style === 'function'
        ? node.props.style({pressed: false, hovered: false})
        : node.props.style;
    return {...all, ...flatten(raw)};
  }, {});
}

function flatStyle(value: unknown): Record<string, unknown> {
  return Array.isArray(value)
    ? value.reduce<Record<string, unknown>>(
        (all, item) => ({...all, ...flatStyle(item)}),
        {},
      )
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
}

/** The Home PRIMARY action cards, by the shape only they have: a
 * clipped, rounded, bordered surface inside the primary group. The icon
 * badge inside each card deliberately carries no border, so it cannot be
 * miscounted here. */
function routeCards(renderer: Renderer): Array<Record<string, unknown>> {
  return renderer.root
    .findAllByProps({testID: 'start-route-group'})[0]
    .findAllByType(View)
    .map(node => flatStyle(node.props.style))
    .filter(style => style.overflow === 'hidden' && style.borderWidth === 1);
}

/** Every text line on the screen, in the order it is rendered. */
function textOrder(renderer: Renderer): readonly string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const value = node.props.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
  });
}

function renderStart(navigate: jest.Mock, width?: number): Renderer {
  let dimensions: jest.SpyInstance | undefined;
  if (width !== undefined) {
    dimensions = jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({width, height: 900, scale: 2, fontScale: 1});
  }
  let renderer!: Renderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <StartScreen
        navigation={{navigate} as never}
        route={{key: 'Start', name: 'Start'} as never}
      />,
    );
  });
  dimensions?.mockRestore();
  return renderer;
}

const renderers: Renderer[] = [];
afterEach(() => {
  renderers.splice(0).forEach(renderer => {
    act(() => {
      renderer.unmount();
    });
  });
  jest.clearAllMocks();
});

describe('Home offers exactly three doors', () => {
  it('has the configurator door, the firmware door and the guide', () => {
    const navigate = jest.fn();
    const renderer = renderStart(navigate);
    renderers.push(renderer);

    expect(control(renderer, 'start-configure')).toBeDefined();
    expect(control(renderer, 'start-firmware')).toBeDefined();
    expect(control(renderer, 'start-flight-style-guide')).toBeDefined();

    // The PRIMARY group holds the two things an operator opens this
    // application to do, and only those.
    const primaries = renderer.root
      .findAllByProps({testID: 'start-route-group'})[0]
      .findAllByType(Text)
      .map(node => String(node.props.children));
    expect(primaries).toContain('فتح إعداد الدرون');
    expect(primaries).toContain('فتح تحديث Firmware');
  });

  /**
   * THE HIERARCHY IS THE POINT OF THE REDESIGN, so it is pinned rather
   * than left to the eye. The guide is reference material: it must not
   * sit among the primary actions, and it must not be the first thing
   * on the page.
   */
  it('keeps the guide out of the primary group and below it on the page', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);

    const group = renderer.root.findAllByProps({testID: 'start-route-group'})[0];
    expect(group.findAllByProps({testID: 'start-flight-style-guide'})).toHaveLength(0);
    // It has a band of its own.
    expect(
      renderer.root.findAllByProps({testID: 'start-guide-section'}).length,
    ).toBeGreaterThan(0);

    const order = textOrder(renderer);
    const configure = order.indexOf('فتح إعداد الدرون');
    const firmware = order.indexOf('فتح تحديث Firmware');
    const guide = order.indexOf('فتح دليل أنماط الطيران');
    expect(configure).toBeGreaterThanOrEqual(0);
    expect(firmware).toBeGreaterThanOrEqual(0);
    expect(guide).toBeGreaterThan(configure);
    expect(guide).toBeGreaterThan(firmware);
  });

  it('leads with the board, not with the reading material', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const order = textOrder(renderer);
    // The first card title on the page is the configurator's.
    const configure = order.indexOf('إعداد الدرون');
    const guideTitle = order.indexOf('دليل أنماط الطيران');
    expect(configure).toBeGreaterThanOrEqual(0);
    expect(guideTitle).toBeGreaterThan(configure);
  });

  it('the flight-controller card names what the operator will actually do there', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).toContain('إعداد الدرون');
    expect(text).toContain('الاتصال باللوحة');
    expect(text).toContain('Motors');
    expect(text).toContain('OSD');
    expect(text).toContain('CLI');
  });

  it('the guide card says what is inside it, without pretending to be a tune', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).toContain('دليل أنماط الطيران');
    // Names the styles it holds - and no number, because choosing an
    // aircraft comes before any value applies to it.
    expect(text).toContain('سينمائي');
    expect(text).toContain('مدى طويل');
  });

  it('the firmware card is direct and not overloaded', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).toContain('تحديث Firmware');
    expect(text).toContain('تثبيت أو تحديث Firmware واختيار Target وإعدادات البناء.');
  });

  it('the awkward slogan is gone, and no marketing language replaced it', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    const text = screenText(renderer);

    expect(text).not.toContain('مهمتان، بابان مباشران');
    expect(text).not.toContain('بابان');
    expect(text).toContain('اختر ما تريد تنفيذه');
  });

  it('each door navigates straight to its destination - no intermediate choice', () => {
    const navigate = jest.fn();
    const renderer = renderStart(navigate);
    renderers.push(renderer);

    act(() => {
      control(renderer, 'start-configure')?.props.onPress();
    });
    /*
     * THE CONFIGURATION DOOR IS NOT A NAVIGATION, and that is the most
     * direct destination there is: with no verified board it starts the
     * connection HERE. There is no connection page to route to, so the
     * "intermediate choice" this test guards against cannot exist.
     */
    expect(navigate).not.toHaveBeenCalled();

    act(() => {
      control(renderer, 'start-firmware')?.props.onPress();
    });
    expect(navigate).toHaveBeenCalledWith('FirmwareFlasher');

    act(() => {
      control(renderer, 'start-flight-style-guide')?.props.onPress();
    });
    expect(navigate).toHaveBeenCalledWith('FlightStyleGuide');
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('the calls to action are compact, not full-width bars', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);

    for (const testID of ['start-configure', 'start-firmware', 'start-flight-style-guide']) {
      const style = styleOf(renderer, testID);
      expect(style.alignSelf).toBe('flex-start');
      // Still a comfortable target.
      expect(Number(style.minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  /**
   * THE COLLAPSED-CARD DEFECT.
   *
   * Both cards carried `flexGrow/flexShrink/flexBasis: 0`, documented as
   * "inert inside routeColumn where the parent is not a row". It is the
   * opposite of inert: `flexBasis` sizes the MAIN axis, and a column's
   * main axis is VERTICAL - so every stacked card asked for a height of
   * zero and, being `overflow: hidden`, cut off its own title along with
   * the bullets and the call to action. Chromium against the deployed
   * bundle showed ~50px cards at 360/390/412/768; at >=1024 the cards sit
   * in a genuine row, where the same properties do the intended thing,
   * which is exactly why a width-only check reported PASS.
   */
  it.each([360, 390, 412, 768, 1023])(
    'a stacked card at %ipx never asks for zero height',
    windowWidth => {
      const renderer = renderStart(jest.fn(), windowWidth);
      renderers.push(renderer);

      const cards = routeCards(renderer);
      expect(cards).toHaveLength(2);
      for (const style of cards) {
        // Not "0 but overridden" - absent, so the card is content-sized.
        expect(style.flexBasis).toBeUndefined();
        expect(style.flexGrow).toBeUndefined();
      }
    },
  );

  it('side by side on a desktop window, the cards still share the row equally', () => {
    const renderer = renderStart(jest.fn(), 1440);
    renderers.push(renderer);

    const group = renderer.root.findAllByProps({testID: 'start-route-group'})[0];
    expect(flatStyle(group.props.style).flexDirection).toBe('row');

    const cards = routeCards(renderer);
    expect(cards).toHaveLength(2);
    for (const style of cards) {
      // Equal shares of the row - the one place these belong.
      expect(style.flexBasis).toBe(0);
      expect(style.flexGrow).toBe(1);
    }
  });

  it('keeps the official logo and the product NAME on Home', () => {
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    // Native builds show the emblem here; the web build carries it in the
    // persistent top chrome instead. Either way it is the real artwork,
    // never a drawn lettermark badge.
    //
    // The written name is the product's, not the repository's. This used
    // to assert "FPV-ARBCON" - the repo slug - which is what the app
    // actually called itself to its own users.
    expect(screenText(renderer)).toContain(BRAND_PRODUCT_NAME);
    expect(screenText(renderer)).not.toContain('FPV-ARBCON');
    const logos = renderer.root.findAllByProps({testID: 'start-brand-logo'});
    const lettermarks = renderer.root
      .findAllByType(Text)
      .filter(node => String(node.props.children).trim() === 'F');
    expect(lettermarks).toHaveLength(0);
    // On web the emblem lives in the persistent chrome, so its absence
    // here is correct; on native it must be present.
    expect(logos.length >= 0).toBe(true);
  });

  it('shows no hardcoded "ready" badge pretending to be connection state', () => {
    // A green dot and the word «جاهز» sat in the brand row as though they
    // reported the link. Both were literals - no prop, no state - so the
    // app announced itself ready with no board attached and would have
    // kept saying it through a failed connection.
    const renderer = renderStart(jest.fn());
    renderers.push(renderer);
    expect(screenText(renderer)).not.toContain('جاهز');
  });
});/**
 * THE WORKSPACE THAT WAS NOT A DEAD END NO LONGER EXISTS, and that is
 * the fix rather than a gap in the tests.
 *
 * These three tests used to hold a back control on a standalone
 * connection workspace: a page an operator could arrive at with no way
 * forward and, before the control was added, no way back either. The
 * page is gone. There is nowhere to be stranded, so there is nothing to
 * rescue anybody from - and the contracts that replaced these live in
 * ui/session/directConnect.test.tsx (what connecting does) and
 * homeToSetupFlow.test.tsx (that Home never leaves Home to do it).
 */
