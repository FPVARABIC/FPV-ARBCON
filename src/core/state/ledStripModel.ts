/**
 * WHAT THE LED BYTES MEAN, once they have been decoded.
 *
 * Pure semantics. No React, no Arabic, no navigation, no MSP client, no
 * knowledge that a session exists. Every claim restates firmware source at
 * the pins recorded in `protocol/msp/decoding/ledStripWireContract.ts`.
 *
 * A NOTE ON WHAT IS DELIBERATELY MISSING. There is no LED simulator here and
 * no colour-conversion helper. The reference configurator has neither either:
 * its grid is a static symbolic editor with no animation of any kind, and no
 * Betaflight command reads back a RENDERED LED colour at any pinned API
 * version. The layer-priority and dependency tables below are metadata for
 * explaining behaviour later - they are not, and must not be presented as, a
 * picture of what the strip is doing right now.
 */

/* ------------------------------------------------------------------ *
 * BUILD CAPABILITY
 * ------------------------------------------------------------------ */

/**
 * Two different firmware build gates, and they are not the same question.
 *
 * `USE_LED_STRIP` alone gives a board the strip GET/SET pair. The palette and
 * mode-colour commands additionally require `USE_LED_STRIP_STATUS_MODE`, and
 * on a board without it those four commands are not merely empty - they do
 * not exist, and the firmware answers "unknown command".
 *
 * The strip GET's trailing capability byte is the board SAYING which of the
 * two it is. It is the only sound evidence: an all-zero LED array means an
 * unconfigured strip on either kind of board, a successful palette read is a
 * consequence rather than a cause, and the target name and array length say
 * nothing at all about it.
 */
export type LedStripBuildCapability =
  | 'BASIC_LED_STRIP'
  | 'ADVANCED_STATUS_MODE'
  | 'UNRECOGNISED_CAPABILITY_BYTE';

/** The two values the firmware actually writes into that byte. */
export const LED_CAPABILITY_BYTE_BASIC = 0;
export const LED_CAPABILITY_BYTE_ADVANCED = 1;

/**
 * Classify the observed byte, and refuse to guess about anything else.
 *
 * A third value has never been emitted by any pinned tree, so it means a
 * firmware whose source nobody here has read. Reporting that plainly is worth
 * more than folding it into "basic" and hoping.
 */
export function classifyLedStripBuildCapability(advancedRaw: number): LedStripBuildCapability {
  if (advancedRaw === LED_CAPABILITY_BYTE_ADVANCED) return 'ADVANCED_STATUS_MODE';
  if (advancedRaw === LED_CAPABILITY_BYTE_BASIC) return 'BASIC_LED_STRIP';
  return 'UNRECOGNISED_CAPABILITY_BYTE';
}

/* ------------------------------------------------------------------ *
 * MODE-COLOUR TUPLE CLASSIFICATION
 * ------------------------------------------------------------------ */

export const LedModeIndex = Object.freeze({
  ORIENTATION: 0,
  HEADFREE: 1,
  HORIZON: 2,
  ANGLE: 3,
  MAG: 4,
  BARO: 5,
  SPECIAL: 6,
  AUX_CHANNEL: 7,
} as const);

export const LED_DIRECTIONAL_MODE_COUNT = 6;
export const LED_DIRECTION_SLOTS_PER_MODE = 6;
export const LED_SPECIAL_SLOT_COUNT = 11;

export type LedModeColorClassification =
  /** A flight-mode colour for one of the six directions. */
  | {readonly kind: 'DIRECTIONAL_MODE_COLOR'; readonly mode: number; readonly direction: number; readonly colorIndex: number}
  /** One of the eleven special-colour slots. */
  | {readonly kind: 'SPECIAL_COLOR'; readonly slot: number; readonly colorIndex: number}
  /**
   * The aux tuple. Its third byte is a CHANNEL INDEX, not a colour - naming
   * it `channel` here is the whole reason this classifier exists rather than
   * a 6x6 matrix built straight out of the decoder.
   */
  | {readonly kind: 'AUX_CHANNEL'; readonly channel: number}
  /** Structurally valid, semantically unrecognised. Carried, never dropped. */
  | {readonly kind: 'UNKNOWN'; readonly mode: number; readonly slot: number; readonly value: number};

export function classifyLedModeColorTuple(tuple: {
  readonly mode: number;
  readonly slot: number;
  readonly value: number;
}): LedModeColorClassification {
  const {mode, slot, value} = tuple;
  if (mode < LED_DIRECTIONAL_MODE_COUNT && slot < LED_DIRECTION_SLOTS_PER_MODE) {
    return Object.freeze({kind: 'DIRECTIONAL_MODE_COLOR', mode, direction: slot, colorIndex: value});
  }
  if (mode === LedModeIndex.SPECIAL && slot < LED_SPECIAL_SLOT_COUNT) {
    return Object.freeze({kind: 'SPECIAL_COLOR', slot, colorIndex: value});
  }
  if (mode === LedModeIndex.AUX_CHANNEL && slot === 0) {
    return Object.freeze({kind: 'AUX_CHANNEL', channel: value});
  }
  return Object.freeze({kind: 'UNKNOWN', mode, slot, value});
}

/* ------------------------------------------------------------------ *
 * FLIGHT-MODE REACHABILITY
 * ------------------------------------------------------------------ */

/**
 * Whether a configured mode colour can ever reach an LED.
 *
 * `RUNTIME_MAPPED` - the firmware's flight-mode table maps to it.
 * `RUNTIME_MAPPED_WHEN_BUILT` - mapped, but only in a build that has the
 *   sensor behind it, so a board without the sensor never selects it.
 * `KNOWN_BUT_RUNTIME_INERT` - the wire carries it, the firmware stores it,
 *   round-trips it and validates writes to it, and no code path ever reads
 *   it. Mode 5 is exactly this: `LED_MODE_COUNT` is 6 so the six slots exist
 *   and are transmitted, but the flight-mode-to-LED table has five entries
 *   and none of them is mode 5. It is an inert control in the reference tab
 *   and it must not be presented as an active one here.
 */
export type LedModeRuntimeStatus =
  | 'RUNTIME_MAPPED'
  | 'RUNTIME_MAPPED_WHEN_BUILT'
  | 'KNOWN_BUT_RUNTIME_INERT';

export const LED_MODE_RUNTIME_STATUS: Readonly<Record<number, LedModeRuntimeStatus>> = Object.freeze({
  [LedModeIndex.ORIENTATION]: 'RUNTIME_MAPPED',
  [LedModeIndex.HEADFREE]: 'RUNTIME_MAPPED',
  [LedModeIndex.HORIZON]: 'RUNTIME_MAPPED',
  [LedModeIndex.ANGLE]: 'RUNTIME_MAPPED',
  /** Guarded by USE_MAG in the firmware's mode table. */
  [LedModeIndex.MAG]: 'RUNTIME_MAPPED_WHEN_BUILT',
  [LedModeIndex.BARO]: 'KNOWN_BUT_RUNTIME_INERT',
});

export function ledModeRuntimeStatus(mode: number): LedModeRuntimeStatus | undefined {
  return LED_MODE_RUNTIME_STATUS[mode];
}

/* ------------------------------------------------------------------ *
 * SPECIAL COLOUR SLOTS
 * ------------------------------------------------------------------ */

/**
 * Eight named slots in a field sized for eleven.
 *
 * `LED_SPECIAL_COLOR_COUNT` is 11 and the firmware transmits, stores and
 * validates writes to all eleven, but its enumeration defines only the first
 * eight. Slots 8, 9 and 10 are zero-filled at reset and have no reader. They
 * are named here rather than omitted so that a save can carry them back
 * unchanged instead of silently zeroing whatever a board held.
 */
export const LedSpecialColorSlot = Object.freeze({
  DISARMED: 0,
  ARMED: 1,
  ANIMATION: 2,
  BACKGROUND: 3,
  BLINK_BACKGROUND: 4,
  GPS_NO_SATS: 5,
  GPS_NO_LOCK: 6,
  GPS_LOCKED: 7,
} as const);

export const LED_SPECIAL_SLOT_NAMED_COUNT = 8;

export type LedSpecialSlotStatus = 'NAMED' | 'UNKNOWN_BUT_PRESERVED';

export function ledSpecialSlotStatus(slot: number): LedSpecialSlotStatus | undefined {
  if (!Number.isInteger(slot) || slot < 0 || slot >= LED_SPECIAL_SLOT_COUNT) return undefined;
  return slot < LED_SPECIAL_SLOT_NAMED_COUNT ? 'NAMED' : 'UNKNOWN_BUT_PRESERVED';
}

/* ------------------------------------------------------------------ *
 * RUNTIME LAYER PRIORITY
 * ------------------------------------------------------------------ */

/**
 * WHICH LAYER WINS WHEN TWO WANT THE SAME LED.
 *
 * The firmware establishes a base colour from each LED's base function, then
 * runs its timed layers in a fixed order, each one overwriting what came
 * before. The enum they are indexed by is declared "in reverse order of
 * priority" and iterated ascending, so the LAST layer to run is the one the
 * pilot sees: warnings beat everything, and a battery-warning flash is not
 * something a rainbow overlay can hide.
 *
 * Ordered lowest priority first. Index 0 is the base-function pass.
 */
export const LED_LAYER_PRIORITY_ORDER = Object.freeze([
  'BASE_FUNCTION',
  'RAINBOW',
  'BLINK',
  'LARSON_SCANNER',
  'THRUST_RING',
  'INDICATOR',
  'VTX',
  'GPS',
  'BATTERY',
  'RSSI',
  'WARNING',
] as const);

export type LedLayer = (typeof LED_LAYER_PRIORITY_ORDER)[number];

/** Higher wins. `BASE_FUNCTION` is 0. */
export function ledLayerPriority(layer: LedLayer): number {
  return LED_LAYER_PRIORITY_ORDER.indexOf(layer);
}

/** The two layers that only exist in builds carrying their subsystem. */
export const LED_BUILD_CONDITIONAL_LAYERS: readonly LedLayer[] = Object.freeze(['VTX', 'GPS']);

/* ------------------------------------------------------------------ *
 * WHAT DEPENDS ON WIRE ORDER, AND WHAT DEPENDS ON POSITION
 * ------------------------------------------------------------------ */

/**
 * Two different ways an LED's behaviour depends on things other than its own
 * settings, and confusing them is how a UI ends up lying to a pilot.
 *
 * `ORDINAL` - the effect walks the matching LEDs in WIRE ORDER and gives each
 * one a different result by its position in that walk. Renumbering the strip
 * changes the animation even though no LED's own configuration changed.
 *
 * `GEOMETRY` - the effect depends on the LED's X/Y relative to the extent of
 * every OTHER configured LED. The firmware recomputes the north/south and
 * east/west boundaries from the min and max of the LEDs in use, so moving one
 * LED can change which quadrant a completely different LED belongs to.
 */
export type LedBehaviourDependency = 'ORDINAL' | 'GEOMETRY';

/** Base functions whose rendering depends on something beyond themselves. */
export const LED_BASE_FUNCTION_DEPENDENCIES: Readonly<Record<number, LedBehaviourDependency>> =
  Object.freeze({
    1: 'GEOMETRY', // FLIGHT_MODE: colour comes from the LED's direction bits
    6: 'ORDINAL', // THRUST_RING: rotation phase indexes the ring LEDs in order
    7: 'ORDINAL', // GPS_BAR: fill counts up the matching LEDs in order
    8: 'ORDINAL', // BATTERY_BAR: same
  });

/** Overlays whose rendering depends on something beyond themselves. */
export const LED_OVERLAY_DEPENDENCIES: Readonly<Record<number, LedBehaviourDependency>> = Object.freeze({
  1: 'ORDINAL', // RAINBOW: hue advances per matching LED in order
  2: 'ORDINAL', // LARSON_SCANNER: sweep position indexes matching LEDs in order
  5: 'GEOMETRY', // INDICATOR: lights the quadrant the stick is pushed toward
});

export function ledBaseFunctionDependency(baseFunction: number): LedBehaviourDependency | undefined {
  return LED_BASE_FUNCTION_DEPENDENCIES[baseFunction];
}

export function ledOverlayDependency(overlayBit: number): LedBehaviourDependency | undefined {
  return LED_OVERLAY_DEPENDENCIES[overlayBit];
}
