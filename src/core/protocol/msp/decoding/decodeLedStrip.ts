/**
 * THE FOUR LED READ PAYLOADS.
 *
 * Every decoder here is STRICTER THAN THE FIRMWARE IT TALKS TO. Betaflight's
 * `sbufReadU8` is a bare `*src->ptr++` with no bounds check, and three of the
 * four LED write handlers have no length guard at all, so a malformed frame
 * reads adjacent memory on the flight controller. Nothing about that is a
 * reason for this side to be equally careless: a payload whose shape does not
 * match the pinned contract is refused here, never interpreted optimistically.
 *
 * NOTHING IS DISCARDED. The two trailing bytes of the strip GET, the three
 * unknown special-colour slots, unknown base-function values and the three
 * reserved overlay bits all survive decoding. A configurator that quietly
 * drops the parts of a board's state it does not recognise cannot save that
 * board's state back without destroying it.
 *
 * Source pins and the packed-word layout live in `ledStripWireContract.ts`.
 */

import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';
import {decodeLedEntry, LED_ENTRY_BYTES, type LedEntry} from './ledStripWireContract';

/* ------------------------------------------------------------------ *
 * MSP_LED_STRIP_CONFIG (48)
 * ------------------------------------------------------------------ */

/** The fixed tail every strip GET carries: `advanced` then `profile`. */
export const LED_STRIP_CONFIG_TRAILER_BYTES = 2;

export interface MspLedStripConfigSnapshot {
  /**
   * How many entries the board's array actually has, DERIVED FROM THIS FRAME.
   *
   * The firmware's `LED_STRIP_MAX_LENGTH` is a compile-time constant that is
   * 64 with `USE_LED_STRIP_64`, 32 otherwise, and free for any target header
   * to define to something else entirely before either branch is reached. It
   * is never announced over MSP. The payload length is the only evidence, so
   * it is the only source used.
   */
  readonly maxLength: number;
  /** Every entry the board sent, in wire order, terminator words included. */
  readonly entries: readonly LedEntry[];
  /**
   * The raw capability byte, exactly as sent. The firmware writes 1 when it
   * was built with `USE_LED_STRIP_STATUS_MODE` and 0 when it has only the
   * simple strip - and on the 0 board the palette and mode-colour commands do
   * not exist at all. It is preserved as a NUMBER rather than reduced to a
   * boolean here because this layer's job is to carry the observation, not to
   * decide what a load sequence should do about it.
   */
  readonly advancedRaw: number;
  /** The board's selected LED profile, read-only for this build. */
  readonly profile: number;
}

/**
 * Refuses anything whose shape is not `N × u32` followed by two bytes.
 *
 * NO ARTIFICIAL COUNT CEILING. `maxLength` is bounded by the frame this
 * function was already handed - one output number per four input bytes, so a
 * hostile length cannot amplify into an allocation larger than its own
 * payload, and the transport bounds that. Inventing a "sane maximum" here
 * would be this module claiming to know a firmware capability it cannot see.
 */
export function decodeLedStripConfig(payload: Uint8Array): MspLedStripConfigSnapshot {
  if (payload.length < LED_STRIP_CONFIG_TRAILER_BYTES) {
    throw new MspPayloadReadError(
      `MSP_LED_STRIP_CONFIG needs at least ${LED_STRIP_CONFIG_TRAILER_BYTES} bytes, got ${payload.length}.`,
    );
  }
  const entryBytes = payload.length - LED_STRIP_CONFIG_TRAILER_BYTES;
  if (entryBytes % LED_ENTRY_BYTES !== 0) {
    throw new MspPayloadReadError(
      `MSP_LED_STRIP_CONFIG entry region must be a multiple of ${LED_ENTRY_BYTES} bytes, got ${entryBytes}.`,
    );
  }
  const maxLength = entryBytes / LED_ENTRY_BYTES;
  const reader = new MspPayloadReader(payload);
  const entries: LedEntry[] = [];
  for (let index = 0; index < maxLength; index++) {
    entries.push(decodeLedEntry(reader.readU32LE(), index));
  }
  const advancedRaw = reader.readU8();
  const profile = reader.readU8();
  return Object.freeze({
    maxLength,
    entries: Object.freeze(entries),
    advancedRaw,
    profile,
  });
}

/* ------------------------------------------------------------------ *
 * MSP_LED_COLORS (46) - the palette
 * ------------------------------------------------------------------ */

/** Sixteen slots, always. `LED_CONFIGURABLE_COLOR_COUNT` in firmware. */
export const LED_PALETTE_SLOT_COUNT = 16;
/** u16 hue + u8 + u8. */
export const LED_PALETTE_SLOT_BYTES = 4;
export const LED_PALETTE_BYTES = LED_PALETTE_SLOT_COUNT * LED_PALETTE_SLOT_BYTES;

export const LED_HUE_MAX = 359;
export const LED_WHITENESS_MAX = 255;
export const LED_VALUE_MAX = 255;

/**
 * ONE PALETTE SLOT - AND THE MIDDLE FIELD IS NOT SATURATION.
 *
 * The firmware struct is `{uint16_t h; uint8_t s; uint8_t v;}` and the field
 * is spelled `s`, but its own default table says what `s` means:
 *
 *   BLACK {0,0,0}      "LED is off"
 *   WHITE {0,255,255}  "for white, S must be 255 and V must be 255, H is ignored"
 *   RED   {0,0,255}    "for full colour S must be 0 and V must be 255"
 *
 * Zero is the most vivid value and 255 is white. That is WHITENESS, the
 * inverse of conventional HSV saturation, and calling the field `saturation`
 * in our own code would guarantee that somebody eventually renders every
 * vivid colour as grey. The wire name is preserved in
 * `LED_PALETTE_WIRE_FIELD_NAMES` for anyone comparing against firmware; the
 * semantic name is the honest one.
 */
export interface LedPaletteColor {
  /** 0..359 degrees. */
  readonly hue: number;
  /** 0 = fully vivid, 255 = white. Firmware calls this field `s`. */
  readonly whiteness: number;
  /** 0 = off, 255 = full brightness. */
  readonly value: number;
}

/** The firmware field spellings, kept so the rename stays traceable. */
export const LED_PALETTE_WIRE_FIELD_NAMES = Object.freeze({
  hue: 'h',
  whiteness: 's',
  value: 'v',
});

export function decodeLedStripColors(payload: Uint8Array): readonly LedPaletteColor[] {
  if (payload.length !== LED_PALETTE_BYTES) {
    throw new MspPayloadReadError(
      `MSP_LED_COLORS must be exactly ${LED_PALETTE_BYTES} bytes, got ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const colors: LedPaletteColor[] = [];
  for (let slot = 0; slot < LED_PALETTE_SLOT_COUNT; slot++) {
    colors.push(
      Object.freeze({
        hue: reader.readU16LE(),
        whiteness: reader.readU8(),
        value: reader.readU8(),
      }),
    );
  }
  return Object.freeze(colors);
}

/* ------------------------------------------------------------------ *
 * MSP_LED_STRIP_MODECOLOR (127) - forty-eight triplets
 * ------------------------------------------------------------------ */

export const LED_MODE_COLOR_TUPLE_BYTES = 3;
/** 6 modes x 6 directions. */
export const LED_DIRECTIONAL_MODE_TUPLE_COUNT = 36;
/** `LED_SPECIAL_COLOR_COUNT` in firmware. */
export const LED_SPECIAL_SLOT_COUNT = 11;
/** The single aux-channel tuple the firmware appends. */
export const LED_AUX_TUPLE_COUNT = 1;
export const LED_MODE_COLOR_TUPLE_COUNT =
  LED_DIRECTIONAL_MODE_TUPLE_COUNT + LED_SPECIAL_SLOT_COUNT + LED_AUX_TUPLE_COUNT;
export const LED_MODE_COLOR_BYTES = LED_MODE_COLOR_TUPLE_COUNT * LED_MODE_COLOR_TUPLE_BYTES;

/**
 * A triplet exactly as it arrived, with no interpretation applied.
 *
 * The third byte is NOT always a colour: for the aux tuple it is a channel
 * index. Naming it `value` keeps the decoder honest and leaves the
 * classification to `state/ledStripModel.ts`, which can say so explicitly.
 */
export interface LedModeColorTuple {
  readonly mode: number;
  readonly slot: number;
  readonly value: number;
}

/**
 * EXACT LENGTH, DELIBERATELY.
 *
 * All three pinned firmware trees emit these forty-eight triplets
 * unconditionally - the counts are compile-time constants and the loop has no
 * branches. Exactness IS the contract, so a frame of any other size is a
 * board this build has not read the source of, and the right answer is to say
 * so rather than to decode a prefix and pretend the rest was not there. A
 * firmware that adds a mode is precisely the case the fail-closed API policy
 * in `ledStripWireContract.ts` exists to catch.
 */
export function decodeLedStripModeColors(payload: Uint8Array): readonly LedModeColorTuple[] {
  if (payload.length !== LED_MODE_COLOR_BYTES) {
    throw new MspPayloadReadError(
      `MSP_LED_STRIP_MODECOLOR must be exactly ${LED_MODE_COLOR_BYTES} bytes, got ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const tuples: LedModeColorTuple[] = [];
  for (let i = 0; i < LED_MODE_COLOR_TUPLE_COUNT; i++) {
    tuples.push(
      Object.freeze({
        mode: reader.readU8(),
        slot: reader.readU8(),
        value: reader.readU8(),
      }),
    );
  }
  return Object.freeze(tuples);
}

/* ------------------------------------------------------------------ *
 * MSP2_GET_LED_STRIP_CONFIG_VALUES (0x3008)
 * ------------------------------------------------------------------ */

export const LED_CONFIG_VALUES_BYTES = 5;

/**
 * Three stored settings. NOT telemetry, and nothing here is polled - the
 * board holds these in its config, exactly like a PID gain.
 */
export interface LedStripRuntimeConfigValues {
  /** Percent. */
  readonly brightness: number;
  /** Hue step between consecutive rainbow-overlay LEDs. */
  readonly rainbowDelta: number;
  /** Rainbow animation frequency. */
  readonly rainbowFreq: number;
}

/**
 * NO `|| DEFAULT` ANYWHERE IN THIS FUNCTION, and that is the point of the
 * comment. The reference tab does `brightness || 50`, which turns a board
 * genuinely reporting 0 into a fabricated 50 and then writes the fabrication
 * back. A zero the board sent is a zero this decoder returns.
 */
export function decodeLedStripConfigValues(payload: Uint8Array): LedStripRuntimeConfigValues {
  if (payload.length !== LED_CONFIG_VALUES_BYTES) {
    throw new MspPayloadReadError(
      `MSP2_GET_LED_STRIP_CONFIG_VALUES must be exactly ${LED_CONFIG_VALUES_BYTES} bytes, got ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    brightness: reader.readU8(),
    rainbowDelta: reader.readU16LE(),
    rainbowFreq: reader.readU16LE(),
  });
}
