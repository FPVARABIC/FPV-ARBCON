/**
 * THE ONE RULE THE GUIDE IS BUILT ON, PINNED AS A TEST.
 *
 * Every value in this package is only true beside the aircraft it was
 * written for. `Dshot300` is correct for a 1S whoop and wrong for a 6S
 * racer; `4.45 V` per cell is correct for one and a fire for the other.
 * So a screen that showed two styles' numbers together would not be
 * untidy - it would be dangerous. The package spent several rounds making
 * each corner self-contained, and integrating it into the app is exactly
 * the moment that could be undone by accident.
 *
 * These tests therefore assert the property, not the pixels: whatever a
 * corner renders, it renders ONLY its own numbers, and the directory that
 * lists the corners carries no numbers at all.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import FlightStyleCornerScreen from './FlightStyleCornerScreen';
import FlightStyleGuideScreen from './FlightStyleGuideScreen';
import {
  FLIGHT_STYLES,
  FLIGHT_STYLE_HERO_IMAGES,
  GUIDE_CORNERS,
  GUIDE_STEP_IMAGES,
  findCorner,
} from '../flight-guides';

function navigationDouble() {
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
  } as unknown as never;
}

function renderCorner(styleId: string) {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = ReactTestRenderer.create(
      <FlightStyleCornerScreen
        navigation={navigationDouble()}
        route={{key: 'corner', name: 'FlightStyleCorner', params: {styleId}} as never}
      />,
    );
  });
  if (tree === undefined) throw new Error('corner did not render');
  return JSON.stringify(tree.toJSON());
}

function renderIndexTree() {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  const navigate = jest.fn();
  act(() => {
    tree = ReactTestRenderer.create(
      <FlightStyleGuideScreen
        navigation={{navigate, goBack: jest.fn()} as unknown as never}
        route={{key: 'guide', name: 'FlightStyleGuide'} as never}
      />,
    );
  });
  if (tree === undefined) throw new Error('index did not render');
  return {tree, navigate};
}

function renderIndex() {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = ReactTestRenderer.create(
      <FlightStyleGuideScreen
        navigation={navigationDouble()}
        route={{key: 'guide', name: 'FlightStyleGuide'} as never}
      />,
    );
  });
  if (tree === undefined) throw new Error('index did not render');
  return JSON.stringify(tree.toJSON());
}

describe('the directory of flight styles', () => {
  it('offers every flight style, and only flight styles', () => {
    const rendered = renderIndex();
    for (const corner of FLIGHT_STYLES) {
      expect(rendered).toContain(corner.titleAr);
    }
    // The firmware card is not a flight style: it is what must be true
    // BEFORE any of them mean anything, and it has its own home entry.
    const firmware = findCorner('firmware');
    expect(firmware).toBeDefined();
    expect(FLIGHT_STYLES.map(corner => corner.id)).not.toContain('firmware');
  });

  it('shows no tuning value at all - a directory is not a guide', () => {
    const rendered = renderIndex();
    // A number pulled from any corner's steps has no business on a page
    // that lists five aircraft the reader has not chosen between yet.
    for (const corner of GUIDE_CORNERS) {
      for (const step of corner.steps) {
        for (const value of step.recommended) {
          if (!/^-?\d/.test(value)) continue;
          expect(rendered).not.toContain(`>${value}<`);
        }
      }
    }
  });
});

describe('a single corner', () => {
  it.each(FLIGHT_STYLES.map(corner => [corner.id, corner.titleAr]))(
    '%s renders its own steps in order, 1..N',
    styleId => {
      const corner = findCorner(styleId);
      if (corner === undefined) throw new Error(`no corner ${styleId}`);
      const rendered = renderCorner(styleId);
      for (const step of corner.steps) {
        expect(rendered).toContain(step.titleAr);
      }
      expect(corner.steps.map(step => step.n)).toEqual(
        corner.steps.map((_step, index) => index + 1),
      );
    },
  );

  it.each(FLIGHT_STYLES.map(corner => [corner.id]))(
    '%s never shows another style by name',
    styleId => {
      const rendered = renderCorner(styleId);
      for (const other of GUIDE_CORNERS) {
        if (other.id === styleId) continue;
        expect(rendered).not.toContain(other.titleEn);
      }
    },
  );

  it.each(FLIGHT_STYLES.map(corner => [corner.id]))(
    '%s carries a written verdict for every setting its steps do not change',
    styleId => {
      const corner = findCorner(styleId);
      if (corner === undefined) throw new Error(`no corner ${styleId}`);
      const rendered = renderCorner(styleId);
      expect(corner.decisions.length).toBeGreaterThan(0);
      for (const decision of corner.decisions) {
        expect(rendered).toContain(decision.what);
      }
    },
  );

  it.each(FLIGHT_STYLES.map(corner => [corner.id]))(
    '%s still states that nothing here is flight or hardware verified',
    styleId => {
      const corner = findCorner(styleId);
      if (corner === undefined) throw new Error(`no corner ${styleId}`);
      expect(corner.hardwareStatus).toBe('NOT VERIFIED — DEFERRED');
      expect(renderCorner(styleId)).toContain('NOT VERIFIED');
    },
  );

  it('answers plainly when the style does not exist, rather than blankly', () => {
    const rendered = renderCorner('no-such-style');
    expect(rendered).toContain('لا يوجد ركن بهذا الاسم');
  });
});

describe('the reviewed package and the app agree', () => {
  it('every step still knows where it happens and still has its picture', () => {
    // The app content is GENERATED from docs/flight-guides, so this
    // guards against a hand-edit or a broken generation quietly gutting
    // it. Deliberately NOT asserting that every step carries a numeric
    // value: three Long Range steps - the ports assignment, enabling GPS,
    // and putting GPS Rescue on a switch - are verified by what must be
    // PRESENT on screen rather than by a number typed into a field, and
    // demanding a value chip from them would be demanding a number the
    // guide correctly refuses to invent.
    for (const corner of GUIDE_CORNERS) {
      for (const step of corner.steps) {
        expect(step.screen.length).toBeGreaterThan(0);
        expect(step.titleAr.length).toBeGreaterThan(0);
        expect(GUIDE_STEP_IMAGES[`${corner.id}/${step.n}`]).toBeDefined();
        expect(step.width).toBeGreaterThan(0);
        expect(step.height).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * THE WIRING, NOT THE PICTURE.
 *
 * A cover photograph attached to the wrong corner is the one mistake in
 * this feature that would be both easy to make and hard to notice: the
 * page still looks finished, and a reader is simply shown the wrong
 * aircraft for the numbers they are about to apply. These tests pin the
 * wiring so it cannot happen silently - whether or not the photographs
 * are present yet.
 */
describe('every card is wired to its own style', () => {
  it.each(FLIGHT_STYLES.map(corner => [corner.id]))(
    'pressing the %s card opens the %s corner and no other',
    styleId => {
      const {tree, navigate} = renderIndexTree();
      const card = tree.root
        .findAllByProps({testID: `guide-card-${styleId}`})
        .find(node => typeof node.props.onPress === 'function');
      expect(card).toBeDefined();
      act(() => {
        card?.props.onPress();
      });
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith('FlightStyleCorner', {styleId});
      tree.unmount();
    },
  );

  it('a registered cover always belongs to the style that holds it', () => {
    // The map is keyed by style id and the file lives inside that
    // style's own folder, so a cross-wired entry shows up as a key whose
    // asset does not come from the matching directory. Until the owner's
    // photographs are committed the map is empty, and this passes
    // vacuously - which is correct: nothing is wired, so nothing is
    // wired wrongly. It starts biting the moment the first one lands.
    for (const [styleId, source] of Object.entries(FLIGHT_STYLE_HERO_IMAGES)) {
      expect(findCorner(styleId)).toBeDefined();
      expect(source).toBeDefined();
      const asset = JSON.stringify(source);
      // Jest's asset transformer stubs the require, so the path is only
      // visible on web-style {uri} sources; when it IS visible, it must
      // name this style's own folder.
      if (asset.includes('/hero/')) {
        expect(asset).toContain(`/${styleId}/hero/`);
      }
    }
  });

  it('every flight style now has its own cover, and no card is left on the fallback', () => {
    // The owner supplied five photographs and they are committed. A card
    // quietly dropping back to the designed panel would mean an asset was
    // lost or unregistered - visible only if someone happened to look at
    // that card, which is exactly what a test is for.
    for (const corner of FLIGHT_STYLES) {
      expect(FLIGHT_STYLE_HERO_IMAGES[corner.id]).toBeDefined();
    }
    expect(renderIndex()).not.toContain('-fallback');
  });

  it('no style is left without a way to be shown - cover or designed panel', () => {
    // StyleCover renders a titled panel when there is no photograph, so
    // every card is complete either way. What must never happen is a
    // card falling back to ANOTHER style's picture.
    const rendered = renderIndex();
    for (const corner of FLIGHT_STYLES) {
      const hasCover = FLIGHT_STYLE_HERO_IMAGES[corner.id] !== undefined;
      const marker = hasCover
        ? `guide-cover-${corner.id}`
        : `guide-cover-${corner.id}-fallback`;
      expect(rendered).toContain(marker);
    }
  });
});
