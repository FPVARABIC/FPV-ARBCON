/**
 * TURNING A BOARD'S COLOUR TRIPLET INTO PIXELS - AND NOTHING ELSE.
 *
 * THIS IS PRESENTATION. It lives under `ui/` deliberately: nothing it
 * computes is ever written back to the aircraft, and no save path may call
 * it. The board stores `{h, s, v}`; a screen needs an RGB. Converting one
 * to the other is a drawing decision, and drawing decisions do not belong
 * in the layer that owns the wire.
 *
 * THE MIDDLE FIELD IS WHITENESS, NOT SATURATION, and this file is where
 * that costs something if it is forgotten. The firmware's own default
 * table settles it:
 *
 *   BLACK {0, 0, 0}      "LED is off"
 *   WHITE {0, 255, 255}  "for white, S must be 255 and V must be 255"
 *   RED   {0, 0, 255}    "for full colour S must be 0 and V must be 255"
 *
 * Zero is the MOST vivid value and 255 is white - the inverse of ordinary
 * HSV saturation. A converter that fed `s` straight into an HSV routine
 * would render the firmware's red as grey and its white as red, and every
 * swatch in the editor would be wrong in a way that looks plausible. So
 * the inversion happens here, once, in `saturationOf`, and the three
 * anchors above are asserted in the tests.
 */

/** 0..255 per channel. */
export interface LedRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface LedColorTriplet {
  /** 0..359 degrees. */
  readonly hue: number;
  /** 0 = fully vivid, 255 = white. The firmware spells this field `s`. */
  readonly whiteness: number;
  /** 0 = off, 255 = full brightness. */
  readonly value: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * THE INVERSION, IN ONE PLACE.
 *
 * Nothing else in this file reads `whiteness`, so there is exactly one
 * line to get wrong and exactly one line under test.
 */
function saturationOf(whiteness: number): number {
  return clamp01(1 - clamp01(whiteness / 255));
}

/**
 * Standard HSV to RGB, once the saturation has been un-inverted.
 *
 * Hue wraps rather than clamps: the firmware's field is a u16 that the
 * settings table bounds at 359, and a board reporting 360 should render as
 * red rather than as an error.
 */
export function ledColorToRgb(color: LedColorTriplet): LedRgb {
  const h = ((color.hue % 360) + 360) % 360;
  const s = saturationOf(color.whiteness);
  const v = clamp01(color.value / 255);

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) {
    rp = c;
    gp = x;
  } else if (h < 120) {
    rp = x;
    gp = c;
  } else if (h < 180) {
    gp = c;
    bp = x;
  } else if (h < 240) {
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }

  return Object.freeze({
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  });
}

/** A CSS colour for a swatch or a grid cell. */
export function ledColorToCss(color: LedColorTriplet): string {
  const {r, g, b} = ledColorToRgb(color);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Relative luminance, so a number drawn on a swatch stays readable
 * whatever the operator sets that slot to.
 *
 * The coefficients are the ITU-R BT.601 luma weights. Anything drawn on
 * top of a user-chosen colour needs SOME rule; picking one and applying it
 * consistently is the difference between a label that is always readable
 * and one that disappears on half the palette.
 */
export function ledColorLuminance(color: LedColorTriplet): number {
  const {r, g, b} = ledColorToRgb(color);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Ink for text sitting on this colour. */
export function ledSwatchInk(color: LedColorTriplet): '#000000' | '#FFFFFF' {
  return ledColorLuminance(color) > 0.55 ? '#000000' : '#FFFFFF';
}

/**
 * Whether this slot would light anything at all.
 *
 * `value` 0 is the firmware's own "LED is off". Saying so beside the
 * swatch stops an operator hunting a wiring fault for a colour slot
 * somebody turned down to zero.
 */
export function ledColorIsOff(color: LedColorTriplet): boolean {
  return color.value === 0;
}

/**
 * The colour to draw a configured LED in, or `undefined` when there is
 * nothing truthful to draw.
 *
 * A board without the status-mode build sends NO palette. Its LEDs still
 * carry a colour INDEX, and that index still means something to the
 * firmware - it just does not tell us which colour it points at. Returning
 * `undefined` makes the screen show the index instead of inventing a
 * sixteen-colour default table and presenting the invention as the
 * aircraft's state.
 */
export function ledNodeSwatch(
  palette: readonly LedColorTriplet[] | undefined,
  colorIndex: number,
): LedColorTriplet | undefined {
  if (palette === undefined) return undefined;
  return palette[colorIndex];
}
