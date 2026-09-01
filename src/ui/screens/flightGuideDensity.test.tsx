/**
 * THE GUIDE IS A DOCUMENT, NOT A CONFIGURATOR SCREEN.
 *
 * Two separate claims, and they are both about staying out of the
 * operator's way:
 *
 *  1. NO FLIGHT CONTROLLER IS NEEDED. The style guide and every style's
 *     corner read nothing from a board, so they must render fully with
 *     no session anywhere - the connection gate covers the configuration
 *     tabs and must never reach these.
 *
 *  2. THE PAGE IS COMPACT. Measured before this pass, on every desktop
 *     width: a 407px cover band, the first setup step at y=683 (below
 *     the fold), a median step card of 2,259px and one of 5,833px, and
 *     24,968px of page - nearly 28 screens. The chrome is now bounded
 *     here; the real rendered geometry at 360/390/412/768/1024/1366/1920
 *     is measured separately in Chromium.
 *
 * These assertions read the STYLE OBJECTS the components actually
 * render with, not the source text, so a value that stops being applied
 * fails the test rather than passing on a stale grep.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import '../../i18n';
import FlightStyleCornerScreen from './FlightStyleCornerScreen';
import FlightStyleGuideScreen from './FlightStyleGuideScreen';
import {GUIDE_CORNERS} from '../flight-guides';

/** Every style the guide ships, taken from the content itself so a new
 *  one cannot be added without being measured. */
const STYLE_IDS = GUIDE_CORNERS.filter(corner => corner.id !== 'firmware').map(corner => corner.id);

const navigation = {navigate: () => {}, goBack: () => {}} as never;

function renderCorner(styleId: string) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <FlightStyleCornerScreen
        navigation={navigation}
        route={{key: 'c', name: 'FlightStyleCorner', params: {styleId}} as never}
      />,
    );
  });
  return renderer;
}

/** Flattens a style prop (array or object) into one object. */
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (all, one) => ({...all, ...flat(one)}),
      {},
    );
  }
  return (style ?? {}) as Record<string, unknown>;
}

describe('the guide needs no flight controller', () => {
  it('renders the style index with no session anywhere', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <FlightStyleGuideScreen
          navigation={navigation}
          route={{key: 'g', name: 'FlightStyleGuide'} as never}
        />,
      );
    });
    expect(
      renderer.root.findAllByProps({testID: 'flight-style-guide-screen'})
        .length,
    ).toBeGreaterThan(0);
    // And it is NOT wrapped in the configuration gate.
    expect(
      renderer.root.findAllByProps({testID: 'connection-gate-title'}).length,
    ).toBe(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it.each(STYLE_IDS)('renders the %s corner with no session', styleId => {
    const renderer = renderCorner(styleId);
    expect(
      renderer.root.findAllByProps({testID: 'flight-style-corner-screen'})
        .length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: `corner-cover-${styleId}`}).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: 'connection-gate-title'}).length,
    ).toBe(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});

describe('every corner is bounded the same way', () => {
  /**
   * THE CAPTURE CAP is the single biggest number on the page. Each step
   * capture is a phone screenshot 708-780px wide taken at 2x; the column
   * stretched it to ~700 CSS px on every desktop width, which is the
   * same picture at 1.8x and a proportionally taller card. Capped at a
   * real phone's width nothing is cropped and nothing is hidden.
   */
  const MAX_CAPTURE_WIDTH = 420;

  it.each(STYLE_IDS)(
    '%s: no step capture may be stretched past a phone width',
    styleId => {
      const renderer = renderCorner(styleId);
      const shots = renderer.root
        .findAllByType('Image' as never, {deep: true})
        .map(node => flat(node.props.style))
        .filter(style => typeof style.aspectRatio === 'number');
      expect(shots.length).toBeGreaterThan(0);
      for (const style of shots) {
        expect(style.maxWidth).toBe(MAX_CAPTURE_WIDTH);
      }
      ReactTestRenderer.act(() => renderer.unmount());
    },
  );

  it.each(STYLE_IDS)('%s: renders its steps, and every one of them', styleId => {
    const corner = GUIDE_CORNERS.find(one => one.id === styleId);
    if (corner === undefined) throw new Error(`no corner ${styleId}`);
    const renderer = renderCorner(styleId);
    for (const step of corner.steps) {
      expect(
        renderer.root.findAllByProps({
          testID: `guide-step-${styleId}-${step.n}`,
        }).length,
      ).toBeGreaterThan(0);
    }
    ReactTestRenderer.act(() => renderer.unmount());
  });

  /**
   * NOTHING WAS DELETED TO MAKE THE PAGE SHORTER. Every recommended
   * value the content declares is still on the page as TEXT - the
   * compaction moved and resized surfaces, it did not drop guidance.
   */
  it.each(STYLE_IDS)('%s: every recommended value is still rendered', styleId => {
    const corner = GUIDE_CORNERS.find(one => one.id === styleId);
    if (corner === undefined) throw new Error(`no corner ${styleId}`);
    const renderer = renderCorner(styleId);
    const texts = renderer.root
      .findAllByType('Text' as never, {deep: true})
      .flatMap(node =>
        React.Children.toArray(node.props.children).filter(
          child => typeof child === 'string',
        ),
      ) as string[];
    for (const step of corner.steps) {
      for (const value of step.recommended) {
        expect(`${styleId}/${step.n}: ${texts.includes(value)}`).toBe(
          `${styleId}/${step.n}: true`,
        );
      }
    }
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
