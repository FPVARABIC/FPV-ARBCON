/**
 * THE FOUR LED WRITE PAYLOADS.
 *
 * These build bytes. They do not send them, do not sequence them, and do not
 * know what a session is - L-C owns all of that. What they do own is the rule
 * that a frame this layer produces is one the firmware would accept, because
 * three of the four firmware handlers have no length guard and `sbufReadU8`
 * has no bounds check: a short frame from us is a read past the end of the
 * buffer on the aircraft.
 *
 * VALIDATION MIRRORS THE FIRMWARE'S OWN ACCEPTANCE, not the reference
 * configurator's UI limits. Where the two disagree - and for the rainbow
 * frequency they do, 360 in the reference's slider against 2000 in the
 * firmware's setting table - the firmware wins, because it is the thing that
 * has to store the value.
 */

import {
  LED_CONFIG_VALUES_BYTES,
  LED_HUE_MAX,
  LED_MODE_COLOR_TUPLE_BYTES,
  LED_PALETTE_BYTES,
  LED_PALETTE_SLOT_COUNT,
  LED_VALUE_MAX,
  LED_WHITENESS_MAX,
  type LedPaletteColor,
  type LedStripRuntimeConfigValues,
} from '../decoding/decodeLedStrip';
import {LED_ENTRY_BYTES} from '../decoding/ledStripWireContract';

/* ------------------------------------------------------------------ *
 * MSP_SET_LED_STRIP_CONFIG (49)
 * ------------------------------------------------------------------ */

/** One index byte plus one packed word. Never more. */
export const LED_STRIP_CONFIG_WRITE_BYTES = 1 + LED_ENTRY_BYTES;

/**
 * FIVE BYTES, ALWAYS.
 *
 * The firmware handler reads the index, then refuses outright unless
 * `dataSize == 5`. It goes on to test for a sixth profile byte, but that
 * branch cannot be reached: the guard above it has already rejected any frame
 * long enough to contain one. So the six-byte "set the profile too" shape is
 * unreachable code in the firmware, and reproducing it here would be building
 * a feature that exists only in a comment.
 *
 * `maxLength` is required rather than defaulted because the only true value
 * for it came off the board in the strip GET. A default of 32 or 64 here
 * would be this function guessing at the one number the protocol refuses to
 * state, and guessing high means a write the firmware answers with an error.
 */
export function encodeLedStripConfigEntry(params: {
  readonly index: number;
  readonly raw: number;
  readonly maxLength: number;
}): Uint8Array {
  const {index, raw, maxLength} = params;
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new RangeError(`LED strip maxLength must be a positive integer, got ${maxLength}.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= maxLength) {
    throw new RangeError(`LED index ${index} is outside the board's observed strip length ${maxLength}.`);
  }
  if (index > 0xff) {
    // The index travels as one byte, so a board whose array is longer than
    // 256 entries would have positions this command simply cannot address.
    throw new RangeError(`LED index ${index} does not fit the single index byte this command carries.`);
  }
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xffffffff) {
    throw new RangeError(`LED entry word out of range: ${raw}.`);
  }
  const payload = new Uint8Array(LED_STRIP_CONFIG_WRITE_BYTES);
  payload[0] = index;
  new DataView(payload.buffer).setUint32(1, raw >>> 0, true);
  return payload;
}

/* ------------------------------------------------------------------ *
 * MSP_SET_LED_COLORS (47) - the whole palette or nothing
 * ------------------------------------------------------------------ */

/**
 * All sixteen slots in one frame.
 *
 * There is no index byte and no count on this command: the firmware loops
 * `LED_CONFIGURABLE_COLOR_COUNT` times over whatever it was given, with no
 * length check whatsoever. A partial palette is therefore not a smaller
 * write, it is a corrupt one, and a caller holding fewer than sixteen colours
 * is refused here rather than padded with values this app invented.
 */
export function encodeLedStripColors(colors: readonly LedPaletteColor[]): Uint8Array {
  if (colors.length !== LED_PALETTE_SLOT_COUNT) {
    throw new RangeError(
      `MSP_SET_LED_COLORS carries exactly ${LED_PALETTE_SLOT_COUNT} slots, got ${colors.length}.`,
    );
  }
  const payload = new Uint8Array(LED_PALETTE_BYTES);
  const view = new DataView(payload.buffer);
  colors.forEach((color, slot) => {
    assertRange(color.hue, 0, LED_HUE_MAX, `palette[${slot}].hue`);
    assertRange(color.whiteness, 0, LED_WHITENESS_MAX, `palette[${slot}].whiteness`);
    assertRange(color.value, 0, LED_VALUE_MAX, `palette[${slot}].value`);
    const offset = slot * 4;
    view.setUint16(offset, color.hue, true);
    payload[offset + 2] = color.whiteness;
    payload[offset + 3] = color.value;
  });
  return payload;
}

/* ------------------------------------------------------------------ *
 * MSP_SET_LED_STRIP_MODECOLOR (221) - one tuple per frame
 * ------------------------------------------------------------------ */

export const LED_MODE_INDEX_DIRECTIONAL_COUNT = 6;
export const LED_MODE_INDEX_SPECIAL = 6;
export const LED_MODE_INDEX_AUX_CHANNEL = 7;
export const LED_DIRECTION_SLOT_COUNT = 6;
export const LED_SPECIAL_SLOT_WRITE_COUNT = 11;
/** The firmware's colour-index guard applies to every branch, aux included. */
export const LED_MODE_COLOR_VALUE_MAX = 15;

/**
 * The write is one triplet, and there is no bulk form - the forty-eight
 * triplets a read returns become forty-eight separate frames.
 *
 * The acceptance rules below are the firmware's, restated: a colour index
 * outside 0..15 is refused for EVERY mode including the aux tuple (the guard
 * sits above the mode branch), a directional mode takes slots 0..5, the
 * special mode takes 0..10, the aux mode takes slot 0 only, and any other
 * mode value is refused. Sending a tuple the firmware would reject earns an
 * MSP error and a save that half-succeeded, so it is refused here first.
 */
export function encodeLedStripModeColor(tuple: {
  readonly mode: number;
  readonly slot: number;
  readonly value: number;
}): Uint8Array {
  const {mode, slot, value} = tuple;
  assertRange(value, 0, LED_MODE_COLOR_VALUE_MAX, 'mode colour value');
  if (!Number.isInteger(mode) || mode < 0) {
    throw new RangeError(`LED mode index out of range: ${mode}.`);
  }
  if (mode < LED_MODE_INDEX_DIRECTIONAL_COUNT) {
    assertRange(slot, 0, LED_DIRECTION_SLOT_COUNT - 1, `direction slot for mode ${mode}`);
  } else if (mode === LED_MODE_INDEX_SPECIAL) {
    assertRange(slot, 0, LED_SPECIAL_SLOT_WRITE_COUNT - 1, 'special colour slot');
  } else if (mode === LED_MODE_INDEX_AUX_CHANNEL) {
    assertRange(slot, 0, 0, 'aux channel slot');
  } else {
    throw new RangeError(`LED mode index ${mode} is not one the firmware accepts.`);
  }
  const payload = new Uint8Array(LED_MODE_COLOR_TUPLE_BYTES);
  payload[0] = mode;
  payload[1] = slot;
  payload[2] = value;
  return payload;
}

/* ------------------------------------------------------------------ *
 * MSP2_SET_LED_STRIP_CONFIG_VALUES (0x3009)
 * ------------------------------------------------------------------ */

/**
 * Bounds from the firmware's own setting table, not from a slider.
 *
 * `ledstrip_brightness` 5..100, `ledstrip_rainbow_delta` 0..HSV_HUE_MAX,
 * `ledstrip_rainbow_freq` 1..2000. The MSP handler itself clamps none of
 * them - it assigns all three straight out of the buffer with no length check
 * either - so every one of these guards is doing work the firmware will not
 * do on our behalf.
 */
export const LED_BRIGHTNESS_MIN = 5;
export const LED_BRIGHTNESS_MAX = 100;
export const LED_RAINBOW_DELTA_MIN = 0;
export const LED_RAINBOW_DELTA_MAX = LED_HUE_MAX;
export const LED_RAINBOW_FREQ_MIN = 1;
export const LED_RAINBOW_FREQ_MAX = 2000;

export function encodeLedStripConfigValues(values: LedStripRuntimeConfigValues): Uint8Array {
  assertRange(values.brightness, LED_BRIGHTNESS_MIN, LED_BRIGHTNESS_MAX, 'brightness');
  assertRange(values.rainbowDelta, LED_RAINBOW_DELTA_MIN, LED_RAINBOW_DELTA_MAX, 'rainbowDelta');
  assertRange(values.rainbowFreq, LED_RAINBOW_FREQ_MIN, LED_RAINBOW_FREQ_MAX, 'rainbowFreq');
  const payload = new Uint8Array(LED_CONFIG_VALUES_BYTES);
  const view = new DataView(payload.buffer);
  payload[0] = values.brightness;
  view.setUint16(1, values.rainbowDelta, true);
  view.setUint16(3, values.rainbowFreq, true);
  return payload;
}

function assertRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`LED ${name} must be an integer in ${min}..${max}, got ${value}.`);
  }
}
