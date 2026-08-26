import {
  encodeLedStripColors,
  encodeLedStripConfigEntry,
  encodeLedStripConfigValues,
  encodeLedStripModeColor,
  LED_BRIGHTNESS_MAX,
  LED_BRIGHTNESS_MIN,
  LED_MODE_COLOR_VALUE_MAX,
  LED_RAINBOW_DELTA_MAX,
  LED_RAINBOW_FREQ_MAX,
  LED_RAINBOW_FREQ_MIN,
  LED_STRIP_CONFIG_WRITE_BYTES,
} from './encodeLedStrip';
import {
  decodeLedStripColors,
  decodeLedStripConfigValues,
  LED_PALETTE_BYTES,
  type LedPaletteColor,
} from '../decoding/decodeLedStrip';
import {
  F10_HSV_ANCHORS,
  F12_CONFIG_VALUES_BYTES,
  F1_ENTRY_BYTES,
  F1_ENTRY_WORD,
  F9_PALETTE_EXPECTED,
} from '../__testUtils__/ledStripFixtures';

describe('MSP_SET_LED_STRIP_CONFIG', () => {
  it('is exactly five bytes: index then the little-endian word', () => {
    const payload = encodeLedStripConfigEntry({index: 7, raw: F1_ENTRY_WORD, maxLength: 32});
    expect(payload).toHaveLength(LED_STRIP_CONFIG_WRITE_BYTES);
    expect(payload).toHaveLength(5);
    expect([...payload]).toEqual([7, ...F1_ENTRY_BYTES]);
  });

  it('never emits a sixth profile byte', () => {
    /* The firmware refuses anything but five bytes before it reaches its own
       profile branch, so the six-byte shape is unreachable code there and a
       feature that exists only in a comment. */
    for (const index of [0, 1, 31]) {
      expect(encodeLedStripConfigEntry({index, raw: 0x12345678, maxLength: 32})).toHaveLength(5);
    }
  });

  it('writes a bit-31 word without sign trouble', () => {
    const payload = encodeLedStripConfigEntry({index: 0, raw: 0xa6d491d6, maxLength: 32});
    expect([...payload]).toEqual([0, 0xd6, 0x91, 0xd4, 0xa6]);
  });

  it('requires the observed strip length and honours it', () => {
    expect(() => encodeLedStripConfigEntry({index: 32, raw: 1, maxLength: 32})).toThrow(RangeError);
    expect(encodeLedStripConfigEntry({index: 32, raw: 1, maxLength: 64})).toHaveLength(5);
    expect(encodeLedStripConfigEntry({index: 19, raw: 1, maxLength: 20})).toHaveLength(5);
    expect(() => encodeLedStripConfigEntry({index: 20, raw: 1, maxLength: 20})).toThrow(RangeError);
  });

  it('refuses a negative or fractional index and a bad word', () => {
    expect(() => encodeLedStripConfigEntry({index: -1, raw: 0, maxLength: 32})).toThrow(RangeError);
    expect(() => encodeLedStripConfigEntry({index: 1.5, raw: 0, maxLength: 32})).toThrow(RangeError);
    expect(() => encodeLedStripConfigEntry({index: 0, raw: -1, maxLength: 32})).toThrow(RangeError);
    expect(() => encodeLedStripConfigEntry({index: 0, raw: 0x1_0000_0000, maxLength: 32})).toThrow(RangeError);
    expect(() => encodeLedStripConfigEntry({index: 0, raw: 0, maxLength: 0})).toThrow(RangeError);
  });

  it('will write the terminator word when a caller explicitly asks for it', () => {
    /* Clearing a trailing entry is a legitimate write. Refusing zero here
       would be this layer deciding a workflow question that belongs to L-C;
       what it must never do is let an EDITED LED become zero by accident,
       and `ledEntryEncodesAsTerminator` is the guard for that. */
    expect([...encodeLedStripConfigEntry({index: 5, raw: 0, maxLength: 32})]).toEqual([5, 0, 0, 0, 0]);
  });
});

describe('MSP_SET_LED_COLORS', () => {
  it('emits all sixteen slots in one sixty-four byte frame', () => {
    const payload = encodeLedStripColors(F9_PALETTE_EXPECTED);
    expect(payload).toHaveLength(LED_PALETTE_BYTES);
    expect(decodeLedStripColors(payload)).toEqual([...F9_PALETTE_EXPECTED]);
  });

  it('writes hue little-endian', () => {
    const palette: LedPaletteColor[] = Array.from({length: 16}, () => ({hue: 0, whiteness: 0, value: 0}));
    palette[0] = {hue: 359, whiteness: 0, value: 255};
    const payload = encodeLedStripColors(palette);
    expect([payload[0], payload[1]]).toEqual([0x67, 0x01]);
  });

  it('preserves the firmware anchors byte for byte', () => {
    const palette: LedPaletteColor[] = Array.from({length: 16}, () => ({hue: 0, whiteness: 0, value: 0}));
    palette[0] = F10_HSV_ANCHORS.black;
    palette[1] = F10_HSV_ANCHORS.white;
    palette[2] = F10_HSV_ANCHORS.red;
    const payload = encodeLedStripColors(palette);
    expect([...payload.slice(0, 12)]).toEqual([0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 255]);
  });

  it('refuses a short palette instead of padding it with invented colours', () => {
    const fifteen: LedPaletteColor[] = Array.from({length: 15}, () => ({hue: 0, whiteness: 0, value: 0}));
    expect(() => encodeLedStripColors(fifteen)).toThrow(RangeError);
    expect(() => encodeLedStripColors([])).toThrow(RangeError);
    expect(() =>
      encodeLedStripColors(Array.from({length: 17}, () => ({hue: 0, whiteness: 0, value: 0}))),
    ).toThrow(RangeError);
  });

  it('refuses an out-of-range component', () => {
    const make = (patch: Partial<LedPaletteColor>): LedPaletteColor[] => {
      const palette: LedPaletteColor[] = Array.from({length: 16}, () => ({hue: 0, whiteness: 0, value: 0}));
      palette[3] = {hue: 0, whiteness: 0, value: 0, ...patch};
      return palette;
    };
    expect(() => encodeLedStripColors(make({hue: 360}))).toThrow(RangeError);
    expect(() => encodeLedStripColors(make({hue: -1}))).toThrow(RangeError);
    expect(() => encodeLedStripColors(make({whiteness: 256}))).toThrow(RangeError);
    expect(() => encodeLedStripColors(make({value: 256}))).toThrow(RangeError);
    expect(encodeLedStripColors(make({hue: 359, whiteness: 255, value: 255}))).toHaveLength(64);
  });
});

describe('MSP_SET_LED_STRIP_MODECOLOR', () => {
  it('emits exactly one three-byte tuple', () => {
    expect([...encodeLedStripModeColor({mode: 3, slot: 2, value: 9})]).toEqual([3, 2, 9]);
  });

  it('accepts what the firmware accepts, per mode', () => {
    expect(encodeLedStripModeColor({mode: 0, slot: 5, value: 0})).toHaveLength(3);
    expect(encodeLedStripModeColor({mode: 5, slot: 0, value: 15})).toHaveLength(3);
    expect(encodeLedStripModeColor({mode: 6, slot: 10, value: 4})).toHaveLength(3);
    expect(encodeLedStripModeColor({mode: 7, slot: 0, value: 3})).toHaveLength(3);
  });

  it('refuses what the firmware refuses, per mode', () => {
    expect(() => encodeLedStripModeColor({mode: 0, slot: 6, value: 0})).toThrow(RangeError);
    expect(() => encodeLedStripModeColor({mode: 6, slot: 11, value: 0})).toThrow(RangeError);
    expect(() => encodeLedStripModeColor({mode: 7, slot: 1, value: 0})).toThrow(RangeError);
    expect(() => encodeLedStripModeColor({mode: 8, slot: 0, value: 0})).toThrow(RangeError);
    expect(() => encodeLedStripModeColor({mode: -1, slot: 0, value: 0})).toThrow(RangeError);
  });

  it('applies the colour-index guard to every mode, aux included', () => {
    /* The firmware's range check sits ABOVE its mode branch, so it constrains
       the aux channel index too - a fact easy to miss and easy to get wrong
       in the other direction by leaving the aux tuple unchecked. */
    expect(LED_MODE_COLOR_VALUE_MAX).toBe(15);
    expect(() => encodeLedStripModeColor({mode: 0, slot: 0, value: 16})).toThrow(RangeError);
    expect(() => encodeLedStripModeColor({mode: 6, slot: 0, value: 16})).toThrow(RangeError);
    expect(() => encodeLedStripModeColor({mode: 7, slot: 0, value: 16})).toThrow(RangeError);
  });
});

describe('MSP2_SET_LED_STRIP_CONFIG_VALUES', () => {
  it('emits five bytes matching the read frame', () => {
    const payload = encodeLedStripConfigValues({brightness: 0x25, rainbowDelta: 0x0102, rainbowFreq: 0x0403});
    expect([...payload]).toEqual([...F12_CONFIG_VALUES_BYTES]);
    expect(decodeLedStripConfigValues(payload)).toEqual({
      brightness: 0x25,
      rainbowDelta: 0x0102,
      rainbowFreq: 0x0403,
    });
  });

  it('uses the firmware setting range, not the reference UI slider range', () => {
    /* The reference caps its rainbow-frequency slider at 360; the firmware's
       own setting table allows up to 2000, and the firmware is the thing that
       has to store the value. */
    expect(LED_RAINBOW_FREQ_MAX).toBe(2000);
    expect(encodeLedStripConfigValues({brightness: 50, rainbowDelta: 0, rainbowFreq: 2000})).toHaveLength(5);
    expect(encodeLedStripConfigValues({brightness: 50, rainbowDelta: 0, rainbowFreq: 361})).toHaveLength(5);
    expect(() =>
      encodeLedStripConfigValues({brightness: 50, rainbowDelta: 0, rainbowFreq: 2001}),
    ).toThrow(RangeError);
  });

  it('enforces the brightness and delta bounds the firmware documents', () => {
    expect([LED_BRIGHTNESS_MIN, LED_BRIGHTNESS_MAX]).toEqual([5, 100]);
    expect(LED_RAINBOW_DELTA_MAX).toBe(359);
    expect(() => encodeLedStripConfigValues({brightness: 4, rainbowDelta: 0, rainbowFreq: 1})).toThrow(RangeError);
    expect(() => encodeLedStripConfigValues({brightness: 101, rainbowDelta: 0, rainbowFreq: 1})).toThrow(RangeError);
    expect(() => encodeLedStripConfigValues({brightness: 50, rainbowDelta: 360, rainbowFreq: 1})).toThrow(RangeError);
    expect(() =>
      encodeLedStripConfigValues({brightness: 50, rainbowDelta: 0, rainbowFreq: LED_RAINBOW_FREQ_MIN - 1}),
    ).toThrow(RangeError);
  });

  it('accepts a zero rainbow delta, which is a legal setting', () => {
    expect(encodeLedStripConfigValues({brightness: 5, rainbowDelta: 0, rainbowFreq: 1})).toHaveLength(5);
  });
});
