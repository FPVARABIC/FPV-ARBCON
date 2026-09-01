/**
 * THE THREE ANCHORS THAT KILL A CONVENTIONAL-HSV READING.
 *
 * The firmware's own default table is the specification:
 *
 *   BLACK {0, 0, 0}      "LED is off"
 *   WHITE {0, 255, 255}  "for white, S must be 255 and V must be 255"
 *   RED   {0, 0, 255}    "for full colour S must be 0 and V must be 255"
 *
 * A converter that treats the middle field as ordinary saturation renders
 * RED as grey and WHITE as red. Those two assertions are the reason this
 * file exists; everything else in it is scaffolding around them.
 */

import {
  ledColorIsOff,
  ledColorLuminance,
  ledColorToCss,
  ledColorToRgb,
  ledNodeSwatch,
  ledSwatchInk,
} from './ledColorPresentation';
import {F10_HSV_ANCHORS} from '../../core/protocol/msp/__testUtils__/ledStripFixtures';

describe('the firmware anchor vectors', () => {
  it('renders BLACK {0,0,0} as black', () => {
    expect(ledColorToRgb(F10_HSV_ANCHORS.black)).toEqual({r: 0, g: 0, b: 0});
  });

  it('renders WHITE {0,255,255} as white, NOT as red', () => {
    expect(ledColorToRgb(F10_HSV_ANCHORS.white)).toEqual({r: 255, g: 255, b: 255});
  });

  it('renders RED {0,0,255} as full red, NOT as grey', () => {
    expect(ledColorToRgb(F10_HSV_ANCHORS.red)).toEqual({r: 255, g: 0, b: 0});
  });

  it('separates white from red, which a saturation misreading would not', () => {
    expect(ledColorToRgb(F10_HSV_ANCHORS.white)).not.toEqual(
      ledColorToRgb(F10_HSV_ANCHORS.red),
    );
  });
});

describe('hue', () => {
  it.each([
    [0, {r: 255, g: 0, b: 0}],
    [60, {r: 255, g: 255, b: 0}],
    [120, {r: 0, g: 255, b: 0}],
    [180, {r: 0, g: 255, b: 255}],
    [240, {r: 0, g: 0, b: 255}],
    [300, {r: 255, g: 0, b: 255}],
  ])('at full vividness, hue %i is the expected primary', (hue, rgb) => {
    expect(ledColorToRgb({hue, whiteness: 0, value: 255})).toEqual(rgb);
  });

  it('wraps rather than clamps, so a board reporting 360 renders as red', () => {
    expect(ledColorToRgb({hue: 360, whiteness: 0, value: 255})).toEqual({r: 255, g: 0, b: 0});
    expect(ledColorToRgb({hue: 420, whiteness: 0, value: 255})).toEqual(
      ledColorToRgb({hue: 60, whiteness: 0, value: 255}),
    );
  });

  it('is ignored entirely when the slot is fully white', () => {
    for (const hue of [0, 90, 200, 359]) {
      expect(ledColorToRgb({hue, whiteness: 255, value: 255})).toEqual({r: 255, g: 255, b: 255});
    }
  });
});

describe('whiteness moves toward white, never away from it', () => {
  it('lightens monotonically as the field rises', () => {
    const luminances = [0, 64, 128, 192, 255].map(whiteness =>
      ledColorLuminance({hue: 120, whiteness, value: 255}),
    );
    for (let i = 1; i < luminances.length; i++) {
      expect(luminances[i]).toBeGreaterThan(luminances[i - 1]);
    }
  });

  it('reaches exactly white at 255 and exactly the pure hue at 0', () => {
    expect(ledColorToRgb({hue: 120, whiteness: 255, value: 255})).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(ledColorToRgb({hue: 120, whiteness: 0, value: 255})).toEqual({r: 0, g: 255, b: 0});
  });
});

describe('value is brightness', () => {
  it('darkens to black at zero whatever the hue and whiteness', () => {
    for (const whiteness of [0, 128, 255]) {
      expect(ledColorToRgb({hue: 200, whiteness, value: 0})).toEqual({r: 0, g: 0, b: 0});
    }
  });

  it('scales the channels linearly', () => {
    expect(ledColorToRgb({hue: 0, whiteness: 0, value: 128})).toEqual({r: 128, g: 0, b: 0});
  });
});

describe('drawing helpers', () => {
  it('emits a CSS colour a stylesheet can take', () => {
    expect(ledColorToCss(F10_HSV_ANCHORS.red)).toBe('rgb(255, 0, 0)');
  });

  it('picks dark ink on a light swatch and light ink on a dark one', () => {
    expect(ledSwatchInk(F10_HSV_ANCHORS.white)).toBe('#000000');
    expect(ledSwatchInk(F10_HSV_ANCHORS.black)).toBe('#FFFFFF');
    expect(ledSwatchInk({hue: 60, whiteness: 0, value: 255})).toBe('#000000');
    expect(ledSwatchInk({hue: 240, whiteness: 0, value: 255})).toBe('#FFFFFF');
  });

  it("reports the firmware's own off state", () => {
    expect(ledColorIsOff(F10_HSV_ANCHORS.black)).toBe(true);
    expect(ledColorIsOff({hue: 0, whiteness: 0, value: 1})).toBe(false);
  });
});

describe('a board that sent no palette gets no invented one', () => {
  it('has no swatch for any index', () => {
    for (const index of [0, 7, 15]) {
      expect(ledNodeSwatch(undefined, index)).toBeUndefined();
    }
  });

  it('returns the observed colour when there is one', () => {
    const palette = [F10_HSV_ANCHORS.black, F10_HSV_ANCHORS.white, F10_HSV_ANCHORS.red];
    expect(ledNodeSwatch(palette, 2)).toBe(F10_HSV_ANCHORS.red);
  });

  it('has no swatch for an index the palette does not reach', () => {
    expect(ledNodeSwatch([F10_HSV_ANCHORS.red], 5)).toBeUndefined();
  });
});
