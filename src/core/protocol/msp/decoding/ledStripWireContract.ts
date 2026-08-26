/**
 * THE LED STRIP WIRE CONTRACT, AND THE SOURCE IT WAS READ FROM.
 *
 * Everything in this file is a restatement of protocol facts taken from
 * pinned Betaflight source. No implementation was copied - not the
 * firmware's C, not the Configurator's JavaScript, not its comments.
 *
 * THE COMMITS THIS SUBSYSTEM WAS READ FROM, WRITTEN DOWN. A version number
 * names a protocol; a COMMIT names the tree somebody actually opened. Both
 * are recorded so that "we read 1.48" stays checkable instead of being a
 * sentence in a report.
 *
 *   Configurator 2026.6.1   14a057ffc58417c5128199fc1233284982a64be3
 *   Firmware API 1.47       7348054f268f0058574719c134e9f149565bb8ea
 *   Firmware API 1.48       6dbc4218fd6bc33bf16ea32c670304d4f89321d5
 *   Firmware API 1.49       e72a8e93695270d54897a8f128cffdf8f74a0245
 *
 * WHAT THE THREE FIRMWARE TREES AGREE ON. `src/main/io/ledstrip.h` is
 * byte-identical across all three, and so are all eight LED handler blocks
 * in `src/main/msp/msp.c`. The packed entry, the palette frame, the
 * mode-colour tuple and the MSP2 value frame therefore have ONE layout
 * across every version this build understands.
 *
 * WHAT THEY DO NOT AGREE ON, and why it is deliberately absent from this
 * file. `ledstrip.c` differs between 1.47 and 1.48: the firmware's DEFAULT
 * palette moved five hues (orange, yellow, lime green, green, mint green),
 * the VTX overlay changed from a discrete lookup to a continuous hue map,
 * and the visual-beeper default flipped. None of that crosses MSP. It is
 * the reason this module declares no named colour constants at all: the
 * palette on the board is the only palette that is true, and a hard-coded
 * "orange is hue 30" would have been silently wrong the moment 1.48
 * shipped.
 *
 * WHY THE THREE CONTRACT IDENTITIES ARE KEPT SEPARATE ANYWAY. Identical
 * layout is a fact about today's bytes, not a licence to forget which tree
 * was read. Collapsing them into one anonymous "current" would make the
 * next divergence invisible, exactly as it would have made the 1.47/1.48
 * palette change invisible if the palette had been on the wire.
 */

/** The trees this file's claims can be checked against. */
export const LED_STRIP_SOURCE_PINS = Object.freeze({
  configurator: '14a057ffc58417c5128199fc1233284982a64be3',
  firmwareApi147: '7348054f268f0058574719c134e9f149565bb8ea',
  firmwareApi148: '6dbc4218fd6bc33bf16ea32c670304d4f89321d5',
  firmwareApi149: 'e72a8e93695270d54897a8f128cffdf8f74a0245',
});

/* ------------------------------------------------------------------ *
 * API AUTHORITY
 * ------------------------------------------------------------------ */

/** The three pinned contracts. Nothing else is speakable. */
export type LedStripApiContract = 'API_1_47' | 'API_1_48' | 'API_1_49';

/**
 * Structurally identical to the PID subsystem's version input on purpose:
 * this is the same product policy applied to a different payload family,
 * not a second one. `ledStripApiPolicyMatchesPidPolicy` in the tests holds
 * that claim to account. It is a separate declaration rather than an import
 * only so that the LED graph carries no runtime edge into the PID module.
 */
export interface LedStripApiVersion {
  readonly major: number;
  readonly minor: number;
}

export type LedStripApiResolution =
  | {readonly kind: 'SOURCE_VERIFIED'; readonly contract: LedStripApiContract}
  /**
   * Newer than anything anybody here has read. It is NOT "1.49 plus extra
   * bytes" - it is a layout nobody has seen. Reads may fall back to the
   * newest verified layout only where a caller asks for it BY NAME; writes
   * never may, because patching a board whose field meanings are unknown is
   * how a configurator bricks a strip.
   */
  | {readonly kind: 'UNVERIFIED_FUTURE_API'; readonly minor: number; readonly newestVerified: LedStripApiContract}
  | {readonly kind: 'BELOW_SUPPORTED_FLOOR'; readonly minor: number}
  | {readonly kind: 'NOT_A_BETAFLIGHT_API'};

export const LED_NEWEST_SOURCE_VERIFIED_CONTRACT: LedStripApiContract = 'API_1_49';
export const LED_NEWEST_SOURCE_VERIFIED_MINOR = 49;
export const LED_OLDEST_SUPPORTED_MINOR = 47;

export function resolveLedStripApi(version: LedStripApiVersion): LedStripApiResolution {
  if (!Number.isInteger(version.major) || !Number.isInteger(version.minor)) {
    return Object.freeze({kind: 'NOT_A_BETAFLIGHT_API'});
  }
  if (version.major !== 1) return Object.freeze({kind: 'NOT_A_BETAFLIGHT_API'});
  if (version.minor < LED_OLDEST_SUPPORTED_MINOR) {
    return Object.freeze({kind: 'BELOW_SUPPORTED_FLOOR', minor: version.minor});
  }
  if (version.minor === 47) return Object.freeze({kind: 'SOURCE_VERIFIED', contract: 'API_1_47'});
  if (version.minor === 48) return Object.freeze({kind: 'SOURCE_VERIFIED', contract: 'API_1_48'});
  if (version.minor === 49) return Object.freeze({kind: 'SOURCE_VERIFIED', contract: 'API_1_49'});
  return Object.freeze({
    kind: 'UNVERIFIED_FUTURE_API',
    minor: version.minor,
    newestVerified: LED_NEWEST_SOURCE_VERIFIED_CONTRACT,
  });
}

/** The contract to decode with, or nothing. Deliberately `undefined` for a
 *  future API: a caller wanting a best-effort read of a known prefix must
 *  name `LED_NEWEST_SOURCE_VERIFIED_CONTRACT` at its own call site, so the
 *  choice is visible there instead of hidden in a fallback here. */
export function ledStripSourceVerifiedContract(
  resolution: LedStripApiResolution,
): LedStripApiContract | undefined {
  return resolution.kind === 'SOURCE_VERIFIED' ? resolution.contract : undefined;
}

export type LedStripWriteAuthority =
  | {readonly kind: 'ALLOWED'; readonly contract: LedStripApiContract}
  | {
      readonly kind: 'REFUSED';
      readonly reason: 'UNVERIFIED_FUTURE_API' | 'BELOW_SUPPORTED_FLOOR' | 'NOT_A_BETAFLIGHT_API';
    };

/** Fail-closed. The only `ALLOWED` is a layout read from pinned source. */
export function ledStripWriteAuthority(resolution: LedStripApiResolution): LedStripWriteAuthority {
  return resolution.kind === 'SOURCE_VERIFIED'
    ? Object.freeze({kind: 'ALLOWED', contract: resolution.contract})
    : Object.freeze({kind: 'REFUSED', reason: resolution.kind});
}

/* ------------------------------------------------------------------ *
 * THE PACKED 32-BIT ENTRY
 * ------------------------------------------------------------------ */

/**
 * ONE LED IS ONE UNSIGNED 32-BIT WORD, and every one of its 32 bits is
 * spoken for:
 *
 *   bits  0..3   Y            (4)
 *   bits  4..7   X            (4)
 *   bits  8..11  base function(4)  - an ENUM VALUE, exactly one
 *   bits 12..21  overlays     (10) - a BITMASK, seven known + three spare
 *   bits 22..25  colour index (4)
 *   bits 26..31  directions   (6)  - a BITMASK, all six may coexist
 *                              --
 *                              32
 *
 * 8 + 4 + 10 + 4 + 6 = 32 exactly. There is no `parameters` field and there
 * are no bits outside these six groups, which is why re-encoding a decoded
 * entry is lossless: the unknown values live INSIDE two of the fields
 * (overlay bits 7..9, base-function values 10..15), never between them.
 *
 * BEWARE THE REFERENCE'S OWN COMMENT. The Configurator documents this
 * layout in the opposite order and labels it "LSB"; its own code four lines
 * below contradicts it, and the firmware header contradicts it. The
 * firmware header is authoritative and is what these constants restate.
 *
 * SIGNEDNESS. JavaScript's `|` and `<<` yield a SIGNED 32-bit int, and `>>`
 * sign-extends, so a word with bit 31 set (any LED with a DOWN direction)
 * would come back negative from a naive shift. Every read here uses `>>>`
 * and every composed word is normalised with `>>> 0`.
 */
export const LED_Y_BIT_OFFSET = 0;
export const LED_Y_BIT_WIDTH = 4;
export const LED_X_BIT_OFFSET = 4;
export const LED_X_BIT_WIDTH = 4;
export const LED_BASE_FUNCTION_BIT_OFFSET = 8;
export const LED_BASE_FUNCTION_BIT_WIDTH = 4;
export const LED_OVERLAY_BIT_OFFSET = 12;
export const LED_OVERLAY_BIT_WIDTH = 10;
export const LED_COLOR_BIT_OFFSET = 22;
export const LED_COLOR_BIT_WIDTH = 4;
export const LED_DIRECTION_BIT_OFFSET = 26;
export const LED_DIRECTION_BIT_WIDTH = 6;

/** The word size those six groups must exactly fill. */
export const LED_ENTRY_BITS = 32;
/** Bytes one packed entry occupies on the wire. */
export const LED_ENTRY_BYTES = 4;

const fieldMask = (width: number): number => (width >= 32 ? 0xffffffff : (1 << width) - 1) >>> 0;

export const LED_Y_VALUE_MASK = fieldMask(LED_Y_BIT_WIDTH);
export const LED_X_VALUE_MASK = fieldMask(LED_X_BIT_WIDTH);
export const LED_BASE_FUNCTION_VALUE_MASK = fieldMask(LED_BASE_FUNCTION_BIT_WIDTH);
export const LED_OVERLAY_VALUE_MASK = fieldMask(LED_OVERLAY_BIT_WIDTH);
export const LED_COLOR_VALUE_MASK = fieldMask(LED_COLOR_BIT_WIDTH);
export const LED_DIRECTION_VALUE_MASK = fieldMask(LED_DIRECTION_BIT_WIDTH);

/** Maximum coordinate on either axis. Four bits each, so 0..15. */
export const LED_COORDINATE_MAX = LED_X_VALUE_MASK;
/** Palette slots addressable by an entry's colour field: all sixteen. */
export const LED_COLOR_INDEX_MAX = LED_COLOR_VALUE_MASK;

/* ------------------------------------------------------------------ *
 * BASE FUNCTION - an enum, never a mask
 * ------------------------------------------------------------------ */

export const LedBaseFunction = Object.freeze({
  COLOR: 0,
  FLIGHT_MODE: 1,
  ARM_STATE: 2,
  BATTERY: 3,
  RSSI: 4,
  GPS: 5,
  THRUST_RING: 6,
  GPS_BAR: 7,
  BATTERY_BAR: 8,
  ALTITUDE: 9,
} as const);

export type LedBaseFunctionId = (typeof LedBaseFunction)[keyof typeof LedBaseFunction];

/** Ten defined values; the nibble can carry sixteen. */
export const LED_BASE_FUNCTION_KNOWN_COUNT = 10;

export function isKnownLedBaseFunction(value: number): value is LedBaseFunctionId {
  return Number.isInteger(value) && value >= 0 && value < LED_BASE_FUNCTION_KNOWN_COUNT;
}

/* ------------------------------------------------------------------ *
 * OVERLAYS - a bitmask, and three of its bits are not ours
 * ------------------------------------------------------------------ */

export const LedOverlayBit = Object.freeze({
  THROTTLE: 0,
  RAINBOW: 1,
  LARSON_SCANNER: 2,
  BLINK: 3,
  VTX: 4,
  INDICATOR: 5,
  WARNING: 6,
} as const);

export type LedOverlayBitId = (typeof LedOverlayBit)[keyof typeof LedOverlayBit];

export const LED_OVERLAY_KNOWN_COUNT = 7;
/** Bits 0..6 of the overlay field - the seven overlays with a meaning. */
export const LED_OVERLAY_KNOWN_MASK = fieldMask(LED_OVERLAY_KNOWN_COUNT);
/**
 * Bits 7..9 of the overlay field. The firmware allocates ten bits and
 * defines seven, so three carry no meaning THAT WE KNOW OF. They are
 * decoded, carried, and written back untouched. Masking the field down to
 * the seven known bits would quietly erase whatever a future firmware -
 * or a board configured by a newer tool - had put there.
 */
export const LED_OVERLAY_RESERVED_MASK = (LED_OVERLAY_VALUE_MASK & ~LED_OVERLAY_KNOWN_MASK) >>> 0;

/* ------------------------------------------------------------------ *
 * DIRECTIONS - a bitmask, exactly six bits, all defined
 * ------------------------------------------------------------------ */

export const LedDirectionBit = Object.freeze({
  NORTH: 0,
  EAST: 1,
  SOUTH: 2,
  WEST: 3,
  UP: 4,
  DOWN: 5,
} as const);

export type LedDirectionBitId = (typeof LedDirectionBit)[keyof typeof LedDirectionBit];

export const LED_DIRECTION_KNOWN_COUNT = 6;

/**
 * WHICH DIRECTION A FLIGHT-MODE LED TAKES ITS COLOUR FROM.
 *
 * The firmware walks the direction bits from bit 0 upward and stops at the
 * first one that is set, so an LED marked both NORTH and SOUTH is coloured
 * as NORTH and its SOUTH bit changes nothing. Returning `undefined` for an
 * empty mask is the whole point: a FLIGHT_MODE LED with no direction takes
 * no mode colour at all and stays on the background colour.
 *
 * This is runtime semantics and it deliberately does not live in the raw
 * decoder - decoding must not collapse a mask into one value.
 */
export function firstSetLedDirection(directionMask: number): LedDirectionBitId | undefined {
  for (let bit = 0; bit < LED_DIRECTION_KNOWN_COUNT; bit++) {
    if (((directionMask >>> bit) & 1) === 1) return bit as LedDirectionBitId;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * THE SEMANTIC ENTRY
 * ------------------------------------------------------------------ */

/**
 * One LED as this app understands it.
 *
 * `index` IS THE PHYSICAL STRIP POSITION - the order the LEDs are wired in,
 * and the index byte of the write command. It is never derived from x/y,
 * from a grid position, from a sort order, from selection order, or from
 * text direction. It is carried explicitly precisely so that no later layer
 * has to guess where it came from.
 *
 * `raw` is kept alongside the decoded fields so that a write path can patch
 * one field of the word the board actually sent instead of reconstructing a
 * word from what this build happens to understand.
 */
export interface LedEntry {
  readonly index: number;
  readonly raw: number;
  readonly x: number;
  readonly y: number;
  /** The nibble as-is. Values 10..15 are unknown and are NOT normalised. */
  readonly baseFunction: number;
  /** Full ten bits, reserved bits 7..9 included. */
  readonly overlayMask: number;
  readonly colorIndex: number;
  /** Six bits. */
  readonly directionMask: number;
}

const readField = (raw: number, offset: number, mask: number): number => (raw >>> offset) & mask;

export function decodeLedEntry(raw: number, index: number): LedEntry {
  const word = raw >>> 0;
  return Object.freeze({
    index,
    raw: word,
    y: readField(word, LED_Y_BIT_OFFSET, LED_Y_VALUE_MASK),
    x: readField(word, LED_X_BIT_OFFSET, LED_X_VALUE_MASK),
    baseFunction: readField(word, LED_BASE_FUNCTION_BIT_OFFSET, LED_BASE_FUNCTION_VALUE_MASK),
    overlayMask: readField(word, LED_OVERLAY_BIT_OFFSET, LED_OVERLAY_VALUE_MASK),
    colorIndex: readField(word, LED_COLOR_BIT_OFFSET, LED_COLOR_VALUE_MASK),
    directionMask: readField(word, LED_DIRECTION_BIT_OFFSET, LED_DIRECTION_VALUE_MASK),
  });
}

/**
 * The word for a semantic entry.
 *
 * Lossless for anything `decodeLedEntry` produced, because the six fields
 * tile the word exactly. It throws rather than truncates on an out-of-range
 * field: a silently masked coordinate is how "the app showed one thing and
 * the board stored another" happens, and this layer exists to stop that.
 */
export function encodeLedEntry(entry: {
  readonly x: number;
  readonly y: number;
  readonly baseFunction: number;
  readonly overlayMask: number;
  readonly colorIndex: number;
  readonly directionMask: number;
}): number {
  assertField(entry.y, LED_Y_VALUE_MASK, 'y');
  assertField(entry.x, LED_X_VALUE_MASK, 'x');
  assertField(entry.baseFunction, LED_BASE_FUNCTION_VALUE_MASK, 'baseFunction');
  assertField(entry.overlayMask, LED_OVERLAY_VALUE_MASK, 'overlayMask');
  assertField(entry.colorIndex, LED_COLOR_VALUE_MASK, 'colorIndex');
  assertField(entry.directionMask, LED_DIRECTION_VALUE_MASK, 'directionMask');
  return (
    ((entry.y << LED_Y_BIT_OFFSET) |
      (entry.x << LED_X_BIT_OFFSET) |
      (entry.baseFunction << LED_BASE_FUNCTION_BIT_OFFSET) |
      (entry.overlayMask << LED_OVERLAY_BIT_OFFSET) |
      (entry.colorIndex << LED_COLOR_BIT_OFFSET) |
      (entry.directionMask << LED_DIRECTION_BIT_OFFSET)) >>>
    0
  );
}

function assertField(value: number, mask: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > mask) {
    throw new RangeError(`LED entry field ${name} out of range: ${value}`);
  }
}

/* ------------------------------------------------------------------ *
 * PATCH HELPERS - the safe way to write one field
 * ------------------------------------------------------------------ */

/**
 * PATCH THE BOARD'S OWN WORD; DO NOT REBUILD ONE.
 *
 * Every helper below takes the raw word as it came off the wire, replaces
 * exactly one field, and leaves all twenty-something other bits untouched -
 * including overlay bits 7..9 and an unknown base-function value it does
 * not itself understand. That is what makes a later save safe against a
 * board carrying state this build has never heard of.
 */
const patchField = (raw: number, value: number, offset: number, mask: number, name: string): number => {
  assertField(value, mask, name);
  return (((raw >>> 0) & ~((mask << offset) >>> 0)) | (value << offset)) >>> 0;
};

export const withLedY = (raw: number, y: number): number =>
  patchField(raw, y, LED_Y_BIT_OFFSET, LED_Y_VALUE_MASK, 'y');
export const withLedX = (raw: number, x: number): number =>
  patchField(raw, x, LED_X_BIT_OFFSET, LED_X_VALUE_MASK, 'x');
export const withLedBaseFunction = (raw: number, baseFunction: number): number =>
  patchField(raw, baseFunction, LED_BASE_FUNCTION_BIT_OFFSET, LED_BASE_FUNCTION_VALUE_MASK, 'baseFunction');
export const withLedOverlayMask = (raw: number, overlayMask: number): number =>
  patchField(raw, overlayMask, LED_OVERLAY_BIT_OFFSET, LED_OVERLAY_VALUE_MASK, 'overlayMask');
export const withLedColorIndex = (raw: number, colorIndex: number): number =>
  patchField(raw, colorIndex, LED_COLOR_BIT_OFFSET, LED_COLOR_VALUE_MASK, 'colorIndex');
export const withLedDirectionMask = (raw: number, directionMask: number): number =>
  patchField(raw, directionMask, LED_DIRECTION_BIT_OFFSET, LED_DIRECTION_VALUE_MASK, 'directionMask');

/**
 * Set or clear one overlay bit while preserving the other nine - including
 * the three reserved ones. `withLedOverlayMask` replaces the whole field
 * and is the wrong tool when the caller only owns one overlay.
 */
export function withLedOverlayBit(raw: number, bit: number, enabled: boolean): number {
  if (!Number.isInteger(bit) || bit < 0 || bit >= LED_OVERLAY_BIT_WIDTH) {
    throw new RangeError(`LED overlay bit out of range: ${bit}`);
  }
  const current = readField(raw >>> 0, LED_OVERLAY_BIT_OFFSET, LED_OVERLAY_VALUE_MASK);
  const next = enabled ? current | (1 << bit) : current & ~(1 << bit);
  return withLedOverlayMask(raw, (next & LED_OVERLAY_VALUE_MASK) >>> 0);
}

/** Set or clear one direction bit, preserving the other five. */
export function withLedDirectionBit(raw: number, bit: number, enabled: boolean): number {
  if (!Number.isInteger(bit) || bit < 0 || bit >= LED_DIRECTION_BIT_WIDTH) {
    throw new RangeError(`LED direction bit out of range: ${bit}`);
  }
  const current = readField(raw >>> 0, LED_DIRECTION_BIT_OFFSET, LED_DIRECTION_VALUE_MASK);
  const next = enabled ? current | (1 << bit) : current & ~(1 << bit);
  return withLedDirectionMask(raw, (next & LED_DIRECTION_VALUE_MASK) >>> 0);
}

/* ------------------------------------------------------------------ *
 * THE ZERO WORD
 * ------------------------------------------------------------------ */

/**
 * A WORD OF ALL ZEROS IS THE END OF THE STRIP, NOT AN LED.
 *
 * The firmware counts LEDs by walking the array from index 0 and stopping
 * at the first entry whose whole 32-bit word is zero. Everything after that
 * point is invisible to the aircraft no matter what it contains.
 *
 * The trap this creates is real and is why `ledEntryEncodesAsTerminator`
 * exists: an LED at x=0, y=0 with base function COLOUR (which is 0), colour
 * index 0, no overlays and no directions is a perfectly reasonable thing
 * for a user to ask for, and it serialises to exactly this word. Written at
 * index 0 it turns the entire strip off. It has to be refused at the point
 * of construction, not discovered afterwards.
 */
export const LED_ENTRY_TERMINATOR = 0;

export function ledEntryEncodesAsTerminator(entry: {
  readonly x: number;
  readonly y: number;
  readonly baseFunction: number;
  readonly overlayMask: number;
  readonly colorIndex: number;
  readonly directionMask: number;
}): boolean {
  return encodeLedEntry(entry) === LED_ENTRY_TERMINATOR;
}

export function isLedTerminatorWord(raw: number): boolean {
  return (raw >>> 0) === LED_ENTRY_TERMINATOR;
}
