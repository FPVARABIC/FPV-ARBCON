import {
  decodeLedStripColors,
  decodeLedStripConfig,
  decodeLedStripConfigValues,
  decodeLedStripModeColors,
  LED_CONFIG_VALUES_BYTES,
  LED_MODE_COLOR_BYTES,
  LED_MODE_COLOR_TUPLE_COUNT,
  LED_PALETTE_BYTES,
  LED_PALETTE_SLOT_COUNT,
  LED_PALETTE_WIRE_FIELD_NAMES,
} from './decodeLedStrip';
import {MspPayloadReadError} from './MspPayloadReader';
import {
  bytes,
  F10_ANCHOR_PALETTE_BYTES,
  F10_HSV_ANCHORS,
  F11_MODECOLOR_BYTES,
  F11_MODECOLOR_EXPECTED,
  F12_ALL_ZERO_BYTES,
  F12_CONFIG_VALUES_BYTES,
  F12_CONFIG_VALUES_EXPECTED,
  F1_ENTRY_BYTES,
  F1_ENTRY_WORD,
  F6_EXPECTED_WORDS,
  F6_STRIP_32,
  F7_EXPECTED_WORDS,
  F7_STRIP_64,
  F8_EXPECTED_WORDS,
  F8_STRIP_20,
  F9_PALETTE_BYTES,
  F9_PALETTE_EXPECTED,
} from '../__testUtils__/ledStripFixtures';

describe('MSP_LED_STRIP_CONFIG', () => {
  it('derives the strip length from the frame, not from a constant', () => {
    expect(decodeLedStripConfig(F6_STRIP_32).maxLength).toBe(32);
    expect(decodeLedStripConfig(F7_STRIP_64).maxLength).toBe(64);
    /* A target may define LED_STRIP_MAX_LENGTH to anything before either
       of the firmware's own 32/64 branches is reached. Twenty is as valid
       as either, and a decoder that hard-codes 32 or 64 fails here. */
    expect(decodeLedStripConfig(F8_STRIP_20).maxLength).toBe(20);
  });

  it('decodes every entry in wire order with its own index', () => {
    const snapshot = decodeLedStripConfig(F6_STRIP_32);
    expect(snapshot.entries).toHaveLength(32);
    expect(snapshot.entries.map((e) => e.raw)).toEqual([...F6_EXPECTED_WORDS]);
    expect(snapshot.entries.map((e) => e.index)).toEqual(F6_EXPECTED_WORDS.map((_w, i) => i));
  });

  it('decodes a 64-entry frame and a 20-entry frame identically in shape', () => {
    expect(decodeLedStripConfig(F7_STRIP_64).entries.map((e) => e.raw)).toEqual([...F7_EXPECTED_WORDS]);
    expect(decodeLedStripConfig(F8_STRIP_20).entries.map((e) => e.raw)).toEqual([...F8_EXPECTED_WORDS]);
  });

  it('preserves the advanced capability byte and the profile byte', () => {
    /* The reference computes `(length - 2) / 4` and then never reads either
       trailing byte, which is how a board without status mode renders as an
       empty strip with nothing reporting why. */
    expect(decodeLedStripConfig(F6_STRIP_32).advancedRaw).toBe(1);
    expect(decodeLedStripConfig(F6_STRIP_32).profile).toBe(2);
    expect(decodeLedStripConfig(F7_STRIP_64).profile).toBe(1);
    expect(decodeLedStripConfig(F8_STRIP_20).advancedRaw).toBe(0);
    expect(decodeLedStripConfig(F8_STRIP_20).profile).toBe(0);
  });

  it('reads the packed word little-endian', () => {
    const frame = bytes([...F1_ENTRY_BYTES, 1, 0]);
    expect(decodeLedStripConfig(frame).entries[0].raw).toBe(F1_ENTRY_WORD);
    /* Byte-reversed, the same four bytes decode to something else entirely. */
    const reversed = bytes([...[...F1_ENTRY_BYTES].reverse(), 1, 0]);
    expect(decodeLedStripConfig(reversed).entries[0].raw).not.toBe(F1_ENTRY_WORD);
  });

  it('accepts a frame with the trailer and no entries', () => {
    const snapshot = decodeLedStripConfig(bytes([1, 3]));
    expect(snapshot.maxLength).toBe(0);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.advancedRaw).toBe(1);
    expect(snapshot.profile).toBe(3);
  });

  it.each([
    ['empty', []],
    ['one byte', [1]],
    ['entry region not a multiple of four', [1, 2, 3, 4, 5, 0, 0]],
    ['entry region one byte short', [1, 2, 3, 0, 0]],
  ])('refuses a malformed frame: %s', (_label, payload) => {
    expect(() => decodeLedStripConfig(bytes(payload))).toThrow(MspPayloadReadError);
  });
});

describe('MSP_LED_COLORS', () => {
  it('decodes sixteen slots of hue/whiteness/value', () => {
    const palette = decodeLedStripColors(F9_PALETTE_BYTES);
    expect(palette).toHaveLength(LED_PALETTE_SLOT_COUNT);
    expect(palette.map((c) => ({hue: c.hue, whiteness: c.whiteness, value: c.value}))).toEqual([
      ...F9_PALETTE_EXPECTED,
    ]);
  });

  it('reads the hue as a little-endian u16, not a byte', () => {
    /* Hue runs to 359, so a decoder reading it as u8 truncates every value
       above 255 and shifts every field after it. */
    const frame = bytes([0x67, 0x01, 0x00, 0xff, ...Array.from({length: 15 * 4}, () => 0)]);
    const palette = decodeLedStripColors(frame);
    expect(palette[0].hue).toBe(0x0167);
    expect(palette[0].hue).toBe(359);
    expect(palette[0].whiteness).toBe(0);
    expect(palette[0].value).toBe(255);
  });

  it('carries the three firmware anchors without reinterpreting them', () => {
    const palette = decodeLedStripColors(F10_ANCHOR_PALETTE_BYTES);
    expect(palette[0]).toEqual(F10_HSV_ANCHORS.black);
    expect(palette[1]).toEqual(F10_HSV_ANCHORS.white);
    expect(palette[2]).toEqual(F10_HSV_ANCHORS.red);
    /* The anchors are the whole argument: the most vivid colour has the
       LOWEST middle field and white has the highest. That field is
       whiteness, and treating it as saturation inverts every colour. */
    expect(palette[2].whiteness).toBeLessThan(palette[1].whiteness);
    expect(palette[2].value).toBe(palette[1].value);
  });

  it('records the wire spelling of the renamed field', () => {
    expect(LED_PALETTE_WIRE_FIELD_NAMES).toEqual({hue: 'h', whiteness: 's', value: 'v'});
  });

  it.each([
    ['too short', LED_PALETTE_BYTES - 1],
    ['too long', LED_PALETTE_BYTES + 1],
    ['fifteen slots', 15 * 4],
    ['empty', 0],
  ])('refuses a palette frame that is %s', (_label, length) => {
    expect(() => decodeLedStripColors(new Uint8Array(length))).toThrow(MspPayloadReadError);
  });
});

describe('MSP_LED_STRIP_MODECOLOR', () => {
  it('decodes all forty-eight triplets in wire order', () => {
    const tuples = decodeLedStripModeColors(F11_MODECOLOR_BYTES);
    expect(tuples).toHaveLength(LED_MODE_COLOR_TUPLE_COUNT);
    expect(tuples).toHaveLength(48);
    expect(tuples.map((t) => ({mode: t.mode, slot: t.slot, value: t.value}))).toEqual([
      ...F11_MODECOLOR_EXPECTED,
    ]);
  });

  it('keeps the firmware emission order: 36 directional, 11 special, 1 aux', () => {
    const tuples = decodeLedStripModeColors(F11_MODECOLOR_BYTES);
    expect(tuples.slice(0, 36).every((t) => t.mode < 6 && t.slot < 6)).toBe(true);
    expect(tuples.slice(36, 47).every((t) => t.mode === 6)).toBe(true);
    expect(tuples.slice(36, 47).map((t) => t.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(tuples[47]).toEqual({mode: 7, slot: 0, value: F11_MODECOLOR_EXPECTED[47].value});
  });

  it('does not confuse the slot byte with the value byte', () => {
    const tuples = decodeLedStripModeColors(F11_MODECOLOR_BYTES);
    const collisions = tuples.filter((t) => t.slot === t.value).length;
    expect(collisions).toBeLessThan(tuples.length);
    expect(tuples[0]).toEqual({mode: 0, slot: 0, value: 1});
    expect(tuples[1]).toEqual({mode: 0, slot: 1, value: 6});
  });

  it.each([
    ['not a multiple of three', LED_MODE_COLOR_BYTES - 1],
    ['a multiple of three but short', LED_MODE_COLOR_BYTES - 3],
    ['longer than the contract', LED_MODE_COLOR_BYTES + 3],
    ['empty', 0],
  ])('refuses a mode-colour frame that is %s', (_label, length) => {
    /* All three pinned trees emit exactly these forty-eight triplets from
       compile-time constants with no branches, so exactness is the contract
       and a different length is a firmware nobody here has read. */
    expect(() => decodeLedStripModeColors(new Uint8Array(length))).toThrow(MspPayloadReadError);
  });
});

describe('MSP2_GET_LED_STRIP_CONFIG_VALUES', () => {
  it('decodes brightness and both little-endian u16 values', () => {
    expect(decodeLedStripConfigValues(F12_CONFIG_VALUES_BYTES)).toEqual(F12_CONFIG_VALUES_EXPECTED);
  });

  it('reads the two u16 fields little-endian', () => {
    const decoded = decodeLedStripConfigValues(F12_CONFIG_VALUES_BYTES);
    expect(decoded.rainbowDelta).toBe(0x0102);
    expect(decoded.rainbowFreq).toBe(0x0403);
    /* Big-endian would have produced 0x0201 and 0x0304. */
    expect(decoded.rainbowDelta).not.toBe(0x0201);
    expect(decoded.rainbowFreq).not.toBe(0x0304);
  });

  it('returns a genuine zero as zero', () => {
    /* The reference does `brightness || 50` and `rainbow_freq || 1`, which
       fabricates values the board never sent and then writes them back. */
    expect(decodeLedStripConfigValues(F12_ALL_ZERO_BYTES)).toEqual({
      brightness: 0,
      rainbowDelta: 0,
      rainbowFreq: 0,
    });
  });

  it.each([
    ['short', LED_CONFIG_VALUES_BYTES - 1],
    ['long', LED_CONFIG_VALUES_BYTES + 1],
    ['empty', 0],
  ])('refuses a %s value frame', (_label, length) => {
    expect(() => decodeLedStripConfigValues(new Uint8Array(length))).toThrow(MspPayloadReadError);
  });
});
