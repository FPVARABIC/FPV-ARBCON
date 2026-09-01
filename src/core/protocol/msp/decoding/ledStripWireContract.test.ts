/* eslint-disable no-bitwise -- these assertions read the same firmware bit
 * fields the module under test writes. */
import {
  decodeLedEntry,
  encodeLedEntry,
  firstSetLedDirection,
  isLedTerminatorWord,
  LedBaseFunction,
  LedDirectionBit,
  LedOverlayBit,
  ledEntryEncodesAsTerminator,
  ledStripSourceVerifiedContract,
  ledStripWriteAuthority,
  resolveLedStripApi,
  withLedBaseFunction,
  withLedColorIndex,
  withLedDirectionBit,
  withLedDirectionMask,
  withLedOverlayBit,
  withLedOverlayMask,
  withLedX,
  withLedY,
  LED_BASE_FUNCTION_BIT_OFFSET,
  LED_BASE_FUNCTION_BIT_WIDTH,
  LED_COLOR_BIT_OFFSET,
  LED_COLOR_BIT_WIDTH,
  LED_DIRECTION_BIT_OFFSET,
  LED_DIRECTION_BIT_WIDTH,
  LED_ENTRY_BITS,
  LED_ENTRY_TERMINATOR,
  LED_NEWEST_SOURCE_VERIFIED_MINOR,
  LED_OLDEST_SUPPORTED_MINOR,
  LED_OVERLAY_BIT_OFFSET,
  LED_OVERLAY_BIT_WIDTH,
  LED_OVERLAY_KNOWN_MASK,
  LED_OVERLAY_RESERVED_MASK,
  LED_STRIP_SOURCE_PINS,
  LED_X_BIT_OFFSET,
  LED_X_BIT_WIDTH,
  LED_Y_BIT_OFFSET,
  LED_Y_BIT_WIDTH,
  type LedStripApiVersion,
} from './ledStripWireContract';
import {resolvePidApi, type PidApiVersion} from './pidWireContracts';
import {
  F1_ENTRY_WORD,
  F1_EXPECTED,
  F2_UNKNOWN_FUNCTION_WORD,
  F5_ALL_FIELDS_MAX_WORD,
  F5_MAX_COORDINATE_WORD,
} from '../__testUtils__/ledStripFixtures';

describe('LED source pins', () => {
  it('records the four commits this subsystem was read from', () => {
    expect(LED_STRIP_SOURCE_PINS).toEqual({
      configurator: '14a057ffc58417c5128199fc1233284982a64be3',
      firmwareApi147: '7348054f268f0058574719c134e9f149565bb8ea',
      firmwareApi148: '6dbc4218fd6bc33bf16ea32c670304d4f89321d5',
      firmwareApi149: 'e72a8e93695270d54897a8f128cffdf8f74a0245',
    });
  });
});

describe('packed entry bit layout', () => {
  it('places every field where the firmware header puts it', () => {
    expect([LED_Y_BIT_OFFSET, LED_Y_BIT_WIDTH]).toEqual([0, 4]);
    expect([LED_X_BIT_OFFSET, LED_X_BIT_WIDTH]).toEqual([4, 4]);
    expect([LED_BASE_FUNCTION_BIT_OFFSET, LED_BASE_FUNCTION_BIT_WIDTH]).toEqual([8, 4]);
    expect([LED_OVERLAY_BIT_OFFSET, LED_OVERLAY_BIT_WIDTH]).toEqual([12, 10]);
    expect([LED_COLOR_BIT_OFFSET, LED_COLOR_BIT_WIDTH]).toEqual([22, 4]);
    expect([LED_DIRECTION_BIT_OFFSET, LED_DIRECTION_BIT_WIDTH]).toEqual([26, 6]);
  });

  it('tiles the whole word with no gap and no overlap', () => {
    const widths =
      LED_Y_BIT_WIDTH +
      LED_X_BIT_WIDTH +
      LED_BASE_FUNCTION_BIT_WIDTH +
      LED_OVERLAY_BIT_WIDTH +
      LED_COLOR_BIT_WIDTH +
      LED_DIRECTION_BIT_WIDTH;
    expect(widths).toBe(LED_ENTRY_BITS);
    /* Every field at maximum must reach exactly all-ones. A field at the
       wrong offset either leaves a hole or collides, and both break this. */
    expect(
      encodeLedEntry({
        x: 15,
        y: 15,
        baseFunction: 15,
        overlayMask: 0x3ff,
        colorIndex: 15,
        directionMask: 0x3f,
      }),
    ).toBe(F5_ALL_FIELDS_MAX_WORD);
  });

  it('decodes F1 into six independently distinguishable fields', () => {
    const entry = decodeLedEntry(F1_ENTRY_WORD, 4);
    expect(entry.index).toBe(4);
    expect(entry.raw).toBe(F1_ENTRY_WORD);
    expect(entry.x).toBe(F1_EXPECTED.x);
    expect(entry.y).toBe(F1_EXPECTED.y);
    expect(entry.baseFunction).toBe(F1_EXPECTED.baseFunction);
    expect(entry.overlayMask).toBe(F1_EXPECTED.overlayMask);
    expect(entry.colorIndex).toBe(F1_EXPECTED.colorIndex);
    expect(entry.directionMask).toBe(F1_EXPECTED.directionMask);
  });

  it('does not swap X and Y', () => {
    const entry = decodeLedEntry(F1_ENTRY_WORD, 0);
    expect(entry.x).toBe(13);
    expect(entry.y).toBe(6);
    expect(entry.x).not.toBe(entry.y);
  });

  it('round-trips F1 losslessly', () => {
    const entry = decodeLedEntry(F1_ENTRY_WORD, 0);
    expect(encodeLedEntry(entry)).toBe(F1_ENTRY_WORD);
  });

  it('keeps a bit-31 word unsigned rather than sign-extending it', () => {
    /* Any DOWN direction sets bit 31. A `>>` instead of `>>>` anywhere in
       the decode path turns the whole word negative. */
    const word = encodeLedEntry({
      x: 0,
      y: 0,
      baseFunction: 0,
      overlayMask: 0,
      colorIndex: 0,
      directionMask: 1 << LedDirectionBit.DOWN,
    });
    expect(word).toBe(0x80000000);
    expect(word).toBeGreaterThan(0);
    const entry = decodeLedEntry(word, 0);
    expect(entry.raw).toBe(0x80000000);
    expect(entry.directionMask).toBe(0x20);
  });

  it('round-trips the all-ones word', () => {
    const entry = decodeLedEntry(F5_ALL_FIELDS_MAX_WORD, 0);
    expect(encodeLedEntry(entry)).toBe(F5_ALL_FIELDS_MAX_WORD);
  });

  it('carries the maximum coordinate pair', () => {
    const entry = decodeLedEntry(F5_MAX_COORDINATE_WORD, 0);
    expect([entry.x, entry.y]).toEqual([15, 15]);
    expect(entry.baseFunction).toBe(0);
  });

  it('refuses an out-of-range field instead of truncating it', () => {
    const base = {x: 0, y: 0, baseFunction: 0, overlayMask: 0, colorIndex: 0, directionMask: 0};
    expect(() => encodeLedEntry({...base, x: 16})).toThrow(RangeError);
    expect(() => encodeLedEntry({...base, y: 16})).toThrow(RangeError);
    expect(() => encodeLedEntry({...base, baseFunction: 16})).toThrow(RangeError);
    expect(() => encodeLedEntry({...base, overlayMask: 0x400})).toThrow(RangeError);
    expect(() => encodeLedEntry({...base, colorIndex: 16})).toThrow(RangeError);
    expect(() => encodeLedEntry({...base, directionMask: 0x40})).toThrow(RangeError);
  });
});

describe('base function is an enum, not a mask', () => {
  it('carries the ten defined values', () => {
    expect(Object.values(LedBaseFunction)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('preserves an unknown nibble value rather than normalising it', () => {
    const entry = decodeLedEntry(F2_UNKNOWN_FUNCTION_WORD, 0);
    expect(entry.baseFunction).toBe(14);
    expect(entry.x).toBe(1);
    expect(entry.y).toBe(2);
    expect(encodeLedEntry(entry)).toBe(F2_UNKNOWN_FUNCTION_WORD);
  });

  it('reads a single value, not a set of bits', () => {
    /* Base function 3 is the value three, not "bits 0 and 1 set". */
    const entry = decodeLedEntry(encodeLedEntry({
      x: 0, y: 0, baseFunction: LedBaseFunction.BATTERY, overlayMask: 0, colorIndex: 0, directionMask: 0,
    }), 0);
    expect(entry.baseFunction).toBe(3);
  });
});

describe('overlays are a bitmask with three bits we do not own', () => {
  it('assigns the seven known overlay bit positions', () => {
    expect(LedOverlayBit).toEqual({
      THROTTLE: 0,
      RAINBOW: 1,
      LARSON_SCANNER: 2,
      BLINK: 3,
      VTX: 4,
      INDICATOR: 5,
      WARNING: 6,
    });
    expect(LED_OVERLAY_KNOWN_MASK).toBe(0x7f);
    expect(LED_OVERLAY_RESERVED_MASK).toBe(0x380);
  });

  it('lets several overlays coexist', () => {
    const entry = decodeLedEntry(F1_ENTRY_WORD, 0);
    expect((entry.overlayMask >>> LedOverlayBit.THROTTLE) & 1).toBe(1);
    expect((entry.overlayMask >>> LedOverlayBit.BLINK) & 1).toBe(1);
    expect((entry.overlayMask >>> LedOverlayBit.WARNING) & 1).toBe(1);
    expect((entry.overlayMask >>> LedOverlayBit.RAINBOW) & 1).toBe(0);
  });

  it('preserves reserved overlay bits 7..9 through a round trip', () => {
    const entry = decodeLedEntry(F1_ENTRY_WORD, 0);
    expect(entry.overlayMask & LED_OVERLAY_RESERVED_MASK).toBe(0x100);
    expect(encodeLedEntry(entry) & (LED_OVERLAY_RESERVED_MASK << LED_OVERLAY_BIT_OFFSET)).toBe(
      0x100 << LED_OVERLAY_BIT_OFFSET,
    );
  });

  it('preserves all three reserved bits when they are all set', () => {
    const word = encodeLedEntry({
      x: 1, y: 2, baseFunction: 3, overlayMask: 0x380, colorIndex: 4, directionMask: 5,
    });
    expect(decodeLedEntry(word, 0).overlayMask).toBe(0x380);
  });
});

describe('directions are a bitmask, six bits, all defined', () => {
  it('assigns the six direction bit positions', () => {
    expect(LedDirectionBit).toEqual({NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3, UP: 4, DOWN: 5});
  });

  it('lets several directions coexist', () => {
    const entry = decodeLedEntry(F1_ENTRY_WORD, 0);
    expect((entry.directionMask >>> LedDirectionBit.NORTH) & 1).toBe(1);
    expect((entry.directionMask >>> LedDirectionBit.WEST) & 1).toBe(1);
    expect((entry.directionMask >>> LedDirectionBit.DOWN) & 1).toBe(1);
    expect((entry.directionMask >>> LedDirectionBit.EAST) & 1).toBe(0);
  });

  it('gives the lowest set direction bit priority, as the firmware does', () => {
    expect(firstSetLedDirection(0b000001)).toBe(LedDirectionBit.NORTH);
    expect(firstSetLedDirection(0b000101)).toBe(LedDirectionBit.NORTH);
    expect(firstSetLedDirection(0b000100)).toBe(LedDirectionBit.SOUTH);
    expect(firstSetLedDirection(0b100000)).toBe(LedDirectionBit.DOWN);
  });

  it('reports no direction at all for an empty mask', () => {
    /* A flight-mode LED with no direction takes no mode colour; folding that
       into "north" would invent a colour the aircraft never shows. */
    expect(firstSetLedDirection(0)).toBeUndefined();
  });
});

describe('colour index spans all sixteen slots', () => {
  it('carries slots 14 and 15, which have no firmware name', () => {
    for (const colorIndex of [0, 13, 14, 15]) {
      const word = encodeLedEntry({x: 3, y: 4, baseFunction: 0, overlayMask: 0, colorIndex, directionMask: 0});
      expect(decodeLedEntry(word, 0).colorIndex).toBe(colorIndex);
    }
  });
});

describe('patch helpers preserve every unrelated bit', () => {
  /* Start from a word with something set in every field, so a helper that
     rebuilds instead of patching loses information it cannot recover. */
  const busy = encodeLedEntry({
    x: 9, y: 5, baseFunction: 13, overlayMask: 0x2a7, colorIndex: 6, directionMask: 0x1b,
  });

  const fields = (word: number) => {
    const e = decodeLedEntry(word, 0);
    return {x: e.x, y: e.y, baseFunction: e.baseFunction, overlayMask: e.overlayMask, colorIndex: e.colorIndex, directionMask: e.directionMask};
  };

  it.each([
    ['x', () => withLedX(busy, 2), 'x', 2],
    ['y', () => withLedY(busy, 12), 'y', 12],
    ['baseFunction', () => withLedBaseFunction(busy, 4), 'baseFunction', 4],
    ['overlayMask', () => withLedOverlayMask(busy, 0x155), 'overlayMask', 0x155],
    ['colorIndex', () => withLedColorIndex(busy, 15), 'colorIndex', 15],
    ['directionMask', () => withLedDirectionMask(busy, 0x24), 'directionMask', 0x24],
  ] as const)('patching %s changes only %s', (_label, patch, key, expected) => {
    const before = fields(busy);
    const after = fields(patch());
    expect(after[key]).toBe(expected);
    for (const other of Object.keys(before) as (keyof typeof before)[]) {
      if (other === key) continue;
      expect(after[other]).toBe(before[other]);
    }
  });

  it('sets one overlay bit without disturbing the other nine', () => {
    const patched = withLedOverlayBit(busy, LedOverlayBit.RAINBOW, true);
    const before = decodeLedEntry(busy, 0);
    const after = decodeLedEntry(patched, 0);
    expect(after.overlayMask).toBe(before.overlayMask | (1 << LedOverlayBit.RAINBOW));
    expect(after.overlayMask & LED_OVERLAY_RESERVED_MASK).toBe(before.overlayMask & LED_OVERLAY_RESERVED_MASK);
    expect(after.colorIndex).toBe(before.colorIndex);
    expect(after.directionMask).toBe(before.directionMask);
  });

  it('clears one overlay bit without disturbing the reserved bits', () => {
    const withReserved = withLedOverlayMask(busy, 0x381);
    const cleared = withLedOverlayBit(withReserved, LedOverlayBit.THROTTLE, false);
    expect(decodeLedEntry(cleared, 0).overlayMask).toBe(0x380);
  });

  it('sets and clears one direction bit in place', () => {
    const on = withLedDirectionBit(busy, LedDirectionBit.UP, true);
    expect(decodeLedEntry(on, 0).directionMask).toBe(0x1b | 0x10);
    const off = withLedDirectionBit(on, LedDirectionBit.NORTH, false);
    expect(decodeLedEntry(off, 0).directionMask).toBe((0x1b | 0x10) & ~0x01);
  });

  it('refuses an out-of-range patch value', () => {
    expect(() => withLedX(busy, 16)).toThrow(RangeError);
    expect(() => withLedOverlayMask(busy, 0x400)).toThrow(RangeError);
    expect(() => withLedOverlayBit(busy, 10, true)).toThrow(RangeError);
    expect(() => withLedDirectionBit(busy, 6, true)).toThrow(RangeError);
  });
});

describe('the zero word is the terminator, never an LED', () => {
  it('recognises the terminator', () => {
    expect(LED_ENTRY_TERMINATOR).toBe(0);
    expect(isLedTerminatorWord(0)).toBe(true);
    expect(isLedTerminatorWord(1)).toBe(false);
  });

  it('flags the LED that would serialise to it', () => {
    /* x=0, y=0, base function COLOUR (which is 0), colour 0, nothing else.
       A reasonable thing to ask for, and the end of the strip. */
    expect(
      ledEntryEncodesAsTerminator({
        x: 0, y: 0, baseFunction: LedBaseFunction.COLOR, overlayMask: 0, colorIndex: 0, directionMask: 0,
      }),
    ).toBe(true);
  });

  it('does not flag an LED that differs in any single field', () => {
    const base = {x: 0, y: 0, baseFunction: 0, overlayMask: 0, colorIndex: 0, directionMask: 0};
    expect(ledEntryEncodesAsTerminator({...base, x: 1})).toBe(false);
    expect(ledEntryEncodesAsTerminator({...base, y: 1})).toBe(false);
    expect(ledEntryEncodesAsTerminator({...base, baseFunction: 1})).toBe(false);
    expect(ledEntryEncodesAsTerminator({...base, overlayMask: 1})).toBe(false);
    expect(ledEntryEncodesAsTerminator({...base, colorIndex: 1})).toBe(false);
    expect(ledEntryEncodesAsTerminator({...base, directionMask: 1})).toBe(false);
  });
});

describe('API authority is fail-closed', () => {
  const v = (minor: number): LedStripApiVersion => ({major: 1, minor});

  it('accepts exactly the three pinned minors, as distinct identities', () => {
    expect(resolveLedStripApi(v(47))).toEqual({kind: 'SOURCE_VERIFIED', contract: 'API_1_47'});
    expect(resolveLedStripApi(v(48))).toEqual({kind: 'SOURCE_VERIFIED', contract: 'API_1_48'});
    expect(resolveLedStripApi(v(49))).toEqual({kind: 'SOURCE_VERIFIED', contract: 'API_1_49'});
    /* Identical wire layout does not make them one contract. */
    expect(new Set(['API_1_47', 'API_1_48', 'API_1_49']).size).toBe(3);
  });

  it('refuses below the floor and above the ceiling', () => {
    expect(resolveLedStripApi(v(46))).toEqual({kind: 'BELOW_SUPPORTED_FLOOR', minor: 46});
    expect(resolveLedStripApi(v(50))).toEqual({
      kind: 'UNVERIFIED_FUTURE_API', minor: 50, newestVerified: 'API_1_49',
    });
    expect(resolveLedStripApi({major: 2, minor: 47})).toEqual({kind: 'NOT_A_BETAFLIGHT_API'});
    expect(resolveLedStripApi({major: 1, minor: 47.5})).toEqual({kind: 'NOT_A_BETAFLIGHT_API'});
  });

  it('grants write authority only for a source-verified contract', () => {
    expect(ledStripWriteAuthority(resolveLedStripApi(v(48)))).toEqual({kind: 'ALLOWED', contract: 'API_1_48'});
    for (const minor of [46, 50, 99]) {
      expect(ledStripWriteAuthority(resolveLedStripApi(v(minor))).kind).toBe('REFUSED');
    }
    expect(ledStripWriteAuthority(resolveLedStripApi(v(50)))).toEqual({
      kind: 'REFUSED', reason: 'UNVERIFIED_FUTURE_API',
    });
  });

  it('returns no decode contract for a future API unless one is named', () => {
    expect(ledStripSourceVerifiedContract(resolveLedStripApi(v(50)))).toBeUndefined();
    expect(ledStripSourceVerifiedContract(resolveLedStripApi(v(49)))).toBe('API_1_49');
  });

  it('applies the same policy the PID subsystem already applies', () => {
    /* Not a second version policy: the same kinds, the same boundaries, the
       same fail-closed answer for the same inputs. */
    expect(LED_OLDEST_SUPPORTED_MINOR).toBe(47);
    expect(LED_NEWEST_SOURCE_VERIFIED_MINOR).toBe(49);
    for (const minor of [1, 46, 47, 48, 49, 50, 120]) {
      const led = resolveLedStripApi({major: 1, minor});
      const pid = resolvePidApi({major: 1, minor} satisfies PidApiVersion);
      expect(led.kind).toBe(pid.kind);
    }
    expect(resolveLedStripApi({major: 3, minor: 48}).kind).toBe(resolvePidApi({major: 3, minor: 48}).kind);
  });
});
