/**
 * HOW LED TRUTH IS SAID, WITHOUT SAYING IT IN ANY ONE LANGUAGE.
 *
 * Every function here returns an i18n KEY and its parameters, never a
 * sentence. Arabic lives in the locale file; this module decides WHICH
 * sentence is true, which is a separate job and a testable one.
 *
 * THREE RULES THIS FILE ENFORCES, and each has a test that fails without it:
 *
 *  1. NO REFERENCE-CONFIGURATOR VOCABULARY. The reference tab labels its
 *     palette slots with English colour names it invented on the client
 *     side - the board sends sixteen HSV triplets and no names at all. A
 *     slot is therefore numbered here, never named, because naming slot 4
 *     "green" is this app asserting something the wire never said.
 *
 *  2. AN UNKNOWN VALUE IS SAID OUT LOUD, NOT NORMALISED. Base function 14
 *     gets its own phrase carrying the number 14. It does not become
 *     "colour" because that is what a `% 10` would have produced.
 *
 *  3. NOTHING HERE PROMISES A LIVE VIEW. The grid is a symbolic layout of
 *     what the strip is configured to do. The board does not report LED
 *     output over MSP and there is nothing to mirror, so every phrase about
 *     the preview says "symbolic" and none of them says "live".
 */

import {
  LED_LAYER_PRIORITY_ORDER,
  LedModeIndex,
  LedSpecialColorSlot,
  ledModeRuntimeStatus,
  ledSpecialSlotStatus,
  type LedLayer,
  type LedModeRuntimeStatus,
  type LedStripBuildCapability,
} from './ledStripModel';
import type {LedEditRefusal, LedSaveBlocker} from './ledStripDraft';
import type {LedSaveGroup} from './ledStripSaveModel';
import {
  LED_BASE_FUNCTION_KNOWN_COUNT,
  LED_DIRECTION_KNOWN_COUNT,
  LED_OVERLAY_KNOWN_COUNT,
  LED_OVERLAY_RESERVED_MASK,
  LedDirectionBit,
  LedOverlayBit,
} from '../protocol/msp/decoding/ledStripWireContract';

const NS = 'ledStripScreen';

export interface LedPhrase {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

const phrase = (key: string, params?: Record<string, string | number>): LedPhrase =>
  Object.freeze(params === undefined ? {key} : {key, params});

/* ================================================================== *
 * BASE FUNCTIONS
 * ================================================================== */

/** The ten defined values, in the order the inspector offers them. Index
 *  IS the wire value, so this array must never be sorted or filtered. */
export const LED_BASE_FUNCTION_IDS: readonly string[] = Object.freeze([
  'COLOR',
  'FLIGHT_MODE',
  'ARM_STATE',
  'BATTERY',
  'RSSI',
  'GPS',
  'THRUST_RING',
  'GPS_BAR',
  'BATTERY_BAR',
  'ALTITUDE',
]);

/**
 * The name of a base function, or an honest statement that this build does
 * not know it.
 *
 * THE NUMBER TRAVELS WITH THE UNKNOWN CASE. An operator who is told
 * "unknown function" and nothing else cannot tell whether their board holds
 * one unknown function or four different ones, and cannot report it. The
 * value they are shown is the value that will be written back unchanged.
 */
export function ledBaseFunctionLabel(baseFunction: number): LedPhrase {
  if (
    Number.isInteger(baseFunction) &&
    baseFunction >= 0 &&
    baseFunction < LED_BASE_FUNCTION_KNOWN_COUNT
  ) {
    return phrase(`${NS}.function.${LED_BASE_FUNCTION_IDS[baseFunction]}`);
  }
  return phrase(`${NS}.function.unknown`, {value: baseFunction});
}

export function ledBaseFunctionHelp(baseFunction: number): LedPhrase | undefined {
  if (
    !Number.isInteger(baseFunction) ||
    baseFunction < 0 ||
    baseFunction >= LED_BASE_FUNCTION_KNOWN_COUNT
  ) {
    return phrase(`${NS}.function.unknownHelp`);
  }
  return phrase(`${NS}.functionHelp.${LED_BASE_FUNCTION_IDS[baseFunction]}`);
}

/* ================================================================== *
 * OVERLAYS
 * ================================================================== */

export const LED_OVERLAY_IDS: readonly string[] = Object.freeze([
  'THROTTLE',
  'RAINBOW',
  'LARSON_SCANNER',
  'BLINK',
  'VTX',
  'INDICATOR',
  'WARNING',
]);

/** The seven overlay bits an operator can toggle, in bit order. */
export const LED_TOGGLEABLE_OVERLAY_BITS: readonly number[] = Object.freeze([
  LedOverlayBit.THROTTLE,
  LedOverlayBit.RAINBOW,
  LedOverlayBit.LARSON_SCANNER,
  LedOverlayBit.BLINK,
  LedOverlayBit.VTX,
  LedOverlayBit.INDICATOR,
  LedOverlayBit.WARNING,
]);

export function ledOverlayLabel(bit: number): LedPhrase {
  if (Number.isInteger(bit) && bit >= 0 && bit < LED_OVERLAY_KNOWN_COUNT) {
    return phrase(`${NS}.overlay.${LED_OVERLAY_IDS[bit]}`);
  }
  return phrase(`${NS}.overlay.unknown`, {bit});
}

/**
 * Whether an LED carries overlay bits this build has no name for.
 *
 * The firmware allocates ten bits and defines seven. A board that has three
 * set is not corrupt and is not something to warn about - it is a board
 * configured by something newer. The notice says only that they exist and
 * will be kept, which is exactly what the save path does with them.
 */
export function ledReservedOverlayNotice(overlayMask: number): LedPhrase | undefined {
  /* eslint-disable-next-line no-bitwise -- reading the reserved bits out of
     the firmware's own mask. */
  return (overlayMask & LED_OVERLAY_RESERVED_MASK) !== 0
    ? phrase(`${NS}.overlay.reservedPreserved`)
    : undefined;
}

/* ================================================================== *
 * DIRECTIONS
 * ================================================================== */

export const LED_DIRECTION_IDS: readonly string[] = Object.freeze([
  'NORTH',
  'EAST',
  'SOUTH',
  'WEST',
  'UP',
  'DOWN',
]);

/** Bit order, which is also the order the firmware searches them in. */
export const LED_DIRECTION_BITS: readonly number[] = Object.freeze([
  LedDirectionBit.NORTH,
  LedDirectionBit.EAST,
  LedDirectionBit.SOUTH,
  LedDirectionBit.WEST,
  LedDirectionBit.UP,
  LedDirectionBit.DOWN,
]);

export function ledDirectionLabel(bit: number): LedPhrase {
  if (Number.isInteger(bit) && bit >= 0 && bit < LED_DIRECTION_KNOWN_COUNT) {
    return phrase(`${NS}.direction.${LED_DIRECTION_IDS[bit]}`);
  }
  return phrase(`${NS}.direction.unknown`, {bit});
}

/**
 * Which direction a flight-mode LED will actually take its colour from.
 *
 * The firmware walks the bits from zero and stops at the first one set, so
 * an LED marked both front and rear is coloured as front and its rear bit
 * changes nothing. An editor that let somebody set four directions without
 * saying which one wins would be hiding the rule, not applying it.
 */
export function ledEffectiveDirectionNote(
  baseFunction: number,
  directionMask: number,
): LedPhrase | undefined {
  if (baseFunction !== 1) return undefined;
  let first: number | undefined;
  let count = 0;
  for (const bit of LED_DIRECTION_BITS) {
    /* eslint-disable-next-line no-bitwise -- one bit of the firmware's mask. */
    if (((directionMask >>> bit) & 1) === 1) {
      if (first === undefined) first = bit;
      count++;
    }
  }
  if (first === undefined) return phrase(`${NS}.direction.noneChosen`);
  if (count === 1) return undefined;
  return phrase(`${NS}.direction.firstWins`, {
    direction: `${NS}.direction.${LED_DIRECTION_IDS[first]}`,
  });
}

/* ================================================================== *
 * PALETTE
 * ================================================================== */

/**
 * A palette slot is NUMBERED, never named.
 *
 * The board sends sixteen `{h, s, v}` triplets and no names. Every colour
 * name in the reference tab is a client-side label bolted onto a slot whose
 * contents the operator is free to change, so a slot labelled "green" that
 * holds purple is a lie the moment anyone edits it.
 */
export function ledPaletteSlotLabel(slot: number): LedPhrase {
  return phrase(`${NS}.palette.slot`, {number: slot + 1});
}

export const LED_PALETTE_FIELD_IDS = Object.freeze(['hue', 'whiteness', 'value'] as const);
export type LedPaletteFieldId = (typeof LED_PALETTE_FIELD_IDS)[number];

export function ledPaletteFieldLabel(field: LedPaletteFieldId): LedPhrase {
  return phrase(`${NS}.palette.field.${field}`);
}

/* ================================================================== *
 * MODE COLOURS
 * ================================================================== */

export const LED_MODE_IDS: readonly string[] = Object.freeze([
  'ORIENTATION',
  'HEADFREE',
  'HORIZON',
  'ANGLE',
  'MAG',
  'BARO',
]);

/** The six flight-mode rows, in wire order. */
export const LED_MODE_INDEXES: readonly number[] = Object.freeze([
  LedModeIndex.ORIENTATION,
  LedModeIndex.HEADFREE,
  LedModeIndex.HORIZON,
  LedModeIndex.ANGLE,
  LedModeIndex.MAG,
  LedModeIndex.BARO,
]);

export function ledModeLabel(mode: number): LedPhrase {
  if (Number.isInteger(mode) && mode >= 0 && mode < LED_MODE_IDS.length) {
    return phrase(`${NS}.mode.${LED_MODE_IDS[mode]}`);
  }
  return phrase(`${NS}.mode.unknown`, {mode});
}

/**
 * What the operator needs to know about a mode row before editing it.
 *
 * Mode 5 is stored, transmitted, round-tripped and validated on write, and
 * nothing in the firmware ever reads it: `LED_MODE_COUNT` is six so the
 * slots exist, and the flight-mode-to-LED table has five entries, none of
 * them mode 5. Presenting that row exactly like the four that work would
 * make this app an inert control wearing a working one's clothes.
 */
export function ledModeRuntimeNote(mode: number): LedPhrase | undefined {
  const status: LedModeRuntimeStatus | undefined = ledModeRuntimeStatus(mode);
  if (status === undefined || status === 'RUNTIME_MAPPED') return undefined;
  return phrase(`${NS}.mode.runtime.${status}`);
}

export const LED_SPECIAL_SLOT_IDS: readonly string[] = Object.freeze([
  'DISARMED',
  'ARMED',
  'ANIMATION',
  'BACKGROUND',
  'BLINK_BACKGROUND',
  'GPS_NO_SATS',
  'GPS_NO_LOCK',
  'GPS_LOCKED',
]);

/**
 * The eleven special slots, named where the firmware names them.
 *
 * `LED_SPECIAL_COLOR_COUNT` is eleven and the enumeration defines eight.
 * The last three are transmitted, stored and writable with no reader, and
 * they are LISTED rather than dropped so a save carries them back unchanged
 * instead of silently zeroing whatever the board held.
 */
export function ledSpecialSlotLabel(slot: number): LedPhrase {
  const status = ledSpecialSlotStatus(slot);
  if (status === undefined) return phrase(`${NS}.special.outOfRange`, {slot});
  if (status === 'NAMED') return phrase(`${NS}.special.${LED_SPECIAL_SLOT_IDS[slot]}`);
  return phrase(`${NS}.special.unknownPreserved`, {slot});
}

/** BACKGROUND is the colour every LED falls back to, so it is the one
 *  special slot whose absence from an editor is immediately visible. */
export const LED_BACKGROUND_SPECIAL_SLOT = LedSpecialColorSlot.BACKGROUND;

export function ledAuxChannelLabel(): LedPhrase {
  return phrase(`${NS}.mode.auxChannel`);
}

/* ================================================================== *
 * RUNTIME VALUES
 * ================================================================== */

export const LED_RUNTIME_FIELD_IDS = Object.freeze([
  'brightness',
  'rainbowDelta',
  'rainbowFreq',
] as const);
export type LedRuntimeFieldId = (typeof LED_RUNTIME_FIELD_IDS)[number];

export function ledRuntimeFieldLabel(field: LedRuntimeFieldId): LedPhrase {
  return phrase(`${NS}.runtime.field.${field}`);
}

export function ledRuntimeFieldHelp(field: LedRuntimeFieldId): LedPhrase {
  return phrase(`${NS}.runtime.help.${field}`);
}

/* ================================================================== *
 * LAYER PRIORITY
 * ================================================================== */

export function ledLayerLabel(layer: LedLayer): LedPhrase {
  return phrase(`${NS}.layer.${layer}`);
}

/** Highest priority first, because that is the order the question gets
 *  asked in: "what will actually be on this LED?" */
export const LED_LAYER_DISPLAY_ORDER: readonly LedLayer[] = Object.freeze(
  [...LED_LAYER_PRIORITY_ORDER].reverse(),
);

/* ================================================================== *
 * CAPABILITY
 * ================================================================== */

export function ledCapabilityNotice(capability: LedStripBuildCapability): LedPhrase | undefined {
  if (capability === 'ADVANCED_STATUS_MODE') return undefined;
  return phrase(`${NS}.capability.${capability}`);
}

/* ================================================================== *
 * THE GRID
 * ================================================================== */

/** `معاينة رمزية`, and the key name says so. The board never reports what
 *  its LEDs are emitting, so there is nothing live to mirror. */
export function ledGridCaption(): LedPhrase {
  return phrase(`${NS}.grid.symbolicPreview`);
}

export function ledFrontMarkerLabel(): LedPhrase {
  return phrase(`${NS}.grid.front`);
}

/** How a cell says it holds more than one LED. Both stay individually
 *  selectable; this is a count, not a merge. */
export function ledClusterBadge(count: number): LedPhrase {
  return phrase(`${NS}.grid.cluster`, {count});
}

/** The human number of an LED beside the wire index it really is. */
export function ledNodeLabel(index: number): LedPhrase {
  return phrase(`${NS}.grid.ledNumber`, {number: index + 1});
}

export function ledMixedValueLabel(): LedPhrase {
  return phrase(`${NS}.inspector.mixed`);
}

/* ================================================================== *
 * REFUSALS AND BLOCKERS
 * ================================================================== */

export const LED_EDIT_REFUSAL_IDS: Readonly<Record<LedEditRefusal, true>> = Object.freeze({
  NO_SELECTION: true,
  VALUE_OUT_OF_RANGE: true,
  WOULD_ENCODE_AS_TERMINATOR: true,
  STRIP_FULL: true,
  ALREADY_PENDING: true,
  NOT_LAST: true,
  NOTHING_TO_DELETE: true,
  PENDING_BLOCKS_REORDER: true,
  NO_NEIGHBOUR: true,
});

export function ledEditRefusalMessage(refusal: LedEditRefusal): LedPhrase {
  return phrase(`${NS}.edit.refusal.${refusal}`);
}

export const LED_SAVE_BLOCKER_IDS: Readonly<Record<LedSaveBlocker, true>> = Object.freeze({
  NO_CHANGES: true,
  PENDING_LED_ENCODES_AS_TERMINATOR: true,
  DRAFT_HAS_GAP: true,
  OBSERVED_STRIP_HAS_GAP: true,
  ADVANCED_CAPABILITY_REQUIRED: true,
});

export function ledSaveBlockerMessage(blocker: LedSaveBlocker): LedPhrase {
  return phrase(`${NS}.save.blocked.${blocker}`);
}

export function ledSaveGroupLabel(group: LedSaveGroup): LedPhrase {
  return phrase(`${NS}.save.group.${group}`);
}

/* ================================================================== *
 * WHAT THE BOARD SAID
 *
 * These unions mirror the controller's result kinds and are declared here
 * rather than imported, so that `core/` keeps no dependency on
 * `platforms/`. `ledStripPresentation.test.ts` imports both sides and
 * fails if either union drifts from the controller's, which is what makes
 * the duplication safe instead of merely convenient.
 * ================================================================== */

export type LedBlockReasonId =
  | 'DISCONNECTED'
  | 'IDENTIFYING'
  | 'UNSUPPORTED_FIRMWARE'
  | 'APP_BACKGROUNDED'
  | 'LINK_RECOVERING'
  | 'OPERATION_IN_PROGRESS'
  | 'UNVERIFIED_FUTURE_API'
  | 'LED_STRIP_UNSUPPORTED_BY_BUILD';

export const LED_BLOCK_REASON_IDS: Readonly<Record<LedBlockReasonId, true>> = Object.freeze({
  DISCONNECTED: true,
  IDENTIFYING: true,
  UNSUPPORTED_FIRMWARE: true,
  APP_BACKGROUNDED: true,
  LINK_RECOVERING: true,
  OPERATION_IN_PROGRESS: true,
  UNVERIFIED_FUTURE_API: true,
  LED_STRIP_UNSUPPORTED_BY_BUILD: true,
});

export function ledBlockReasonMessage(reason: LedBlockReasonId): LedPhrase {
  return phrase(`${NS}.blocked.${reason}`);
}

/**
 * A future firmware is READ-ONLY, not broken.
 *
 * The strip layout this build understands was read out of three pinned
 * firmware trees. A newer one may pack the same thirty-two bits
 * differently, and writing our layout to it would scramble a working
 * strip. Reading it back and showing it costs nothing and risks nothing,
 * so the screen shows what it read and refuses only the writes.
 */
export function ledEditingAllowed(reason: LedBlockReasonId | undefined): boolean {
  return reason === undefined;
}

export function ledReadOnlyNotice(reason: LedBlockReasonId | undefined): LedPhrase | undefined {
  return reason === 'UNVERIFIED_FUTURE_API' ? phrase(`${NS}.blocked.futureApiReadOnly`) : undefined;
}

export type LedLoadOutcomeId =
  | 'LOADED'
  | 'REJECTED'
  | 'CAPABILITY_CONTRADICTION'
  | 'SESSION_ENDED'
  | 'FAILED';

export const LED_LOAD_OUTCOME_IDS: Readonly<Record<LedLoadOutcomeId, true>> = Object.freeze({
  LOADED: true,
  REJECTED: true,
  CAPABILITY_CONTRADICTION: true,
  SESSION_ENDED: true,
  FAILED: true,
});

/** The board claimed the advanced build and then refused one of its own
 *  commands. Naming the resource is the difference between a report and a
 *  shrug. */
export function ledCapabilityContradictionMessage(resource: LedSaveGroup): LedPhrase {
  return phrase(`${NS}.load.capabilityContradiction`, {
    resource: `${NS}.save.group.${resource}`,
  });
}

export type LedSaveOutcomeId =
  | 'SAVE_VERIFIED'
  | 'NO_CHANGES'
  | 'REJECTED'
  | 'REFUSED'
  | 'READBACK_MISMATCH'
  | 'PARTIAL_APPLY'
  | 'APPLIED_NOT_PERSISTED'
  | 'SESSION_LOST_DURING_SAVE'
  | 'SESSION_ENDED'
  | 'FAILED';

export const LED_SAVE_OUTCOME_IDS: Readonly<Record<LedSaveOutcomeId, true>> = Object.freeze({
  SAVE_VERIFIED: true,
  NO_CHANGES: true,
  REJECTED: true,
  REFUSED: true,
  READBACK_MISMATCH: true,
  PARTIAL_APPLY: true,
  APPLIED_NOT_PERSISTED: true,
  SESSION_LOST_DURING_SAVE: true,
  SESSION_ENDED: true,
  FAILED: true,
});

export function ledSaveOutcomeMessage(outcome: LedSaveOutcomeId): LedPhrase {
  return phrase(`${NS}.save.outcome.${outcome}`);
}

/**
 * How loudly to say it - and the three-way split is the point.
 *
 * `APPLIED_NOT_PERSISTED` is the state this app exists to report honestly:
 * the strip on the bench is right, every readback agreed, and the board
 * did not commit it to flash. Calling that a success loses the aircraft's
 * configuration at the next power cycle; calling it a failure sends the
 * operator to redo work that is already applied. It is its own outcome
 * with its own sentence and its own action.
 */
export function ledSaveOutcomeSeverity(
  outcome: LedSaveOutcomeId,
): 'SUCCESS' | 'ATTENTION' | 'INFORMATION' {
  switch (outcome) {
    case 'SAVE_VERIFIED':
      return 'SUCCESS';
    case 'NO_CHANGES':
      return 'INFORMATION';
    case 'REJECTED':
    case 'REFUSED':
    case 'READBACK_MISMATCH':
    case 'PARTIAL_APPLY':
    case 'APPLIED_NOT_PERSISTED':
    case 'SESSION_LOST_DURING_SAVE':
    case 'SESSION_ENDED':
    case 'FAILED':
      return 'ATTENTION';
  }
}

/** Whether the screen must re-read the board before the operator edits
 *  again. After anything that half-applied, the draft's baseline is a
 *  description of a board that no longer exists. */
export function ledSaveRequiresReload(outcome: LedSaveOutcomeId): boolean {
  switch (outcome) {
    case 'READBACK_MISMATCH':
    case 'PARTIAL_APPLY':
    case 'APPLIED_NOT_PERSISTED':
    case 'SESSION_LOST_DURING_SAVE':
      return true;
    case 'SAVE_VERIFIED':
    case 'NO_CHANGES':
    case 'REJECTED':
    case 'REFUSED':
    case 'SESSION_ENDED':
    case 'FAILED':
      return false;
  }
}

export type LedSaveRefusalId =
  | 'STALE_SESSION'
  | 'ADVANCED_LED_STATUS_UNAVAILABLE'
  | 'ENTRY_PLAN_REFUSED'
  | 'STALE_PALETTE_SLOT'
  | 'STALE_MODE_COLOR'
  | 'MODE_COLOR_TUPLE_ABSENT'
  | 'STALE_RUNTIME_VALUE'
  | 'INVALID_DRAFT';

export const LED_SAVE_REFUSAL_IDS: Readonly<Record<LedSaveRefusalId, true>> = Object.freeze({
  STALE_SESSION: true,
  ADVANCED_LED_STATUS_UNAVAILABLE: true,
  ENTRY_PLAN_REFUSED: true,
  STALE_PALETTE_SLOT: true,
  STALE_MODE_COLOR: true,
  MODE_COLOR_TUPLE_ABSENT: true,
  STALE_RUNTIME_VALUE: true,
  INVALID_DRAFT: true,
});

export function ledSaveRefusalMessage(refusal: LedSaveRefusalId): LedPhrase {
  return phrase(`${NS}.save.refusal.${refusal}`);
}

export type LedEntryPlanRefusalId =
  | 'TARGET_LENGTH_MISMATCH'
  | 'TARGET_WORD_INVALID'
  | 'TARGET_HAS_GAP'
  | 'TARGET_EFFECTIVE_COUNT_MISMATCH'
  | 'OBSERVED_STRIP_HAS_GAP'
  | 'STALE_ENTRIES_STATE';

export const LED_ENTRY_PLAN_REFUSAL_IDS: Readonly<Record<LedEntryPlanRefusalId, true>> =
  Object.freeze({
    TARGET_LENGTH_MISMATCH: true,
    TARGET_WORD_INVALID: true,
    TARGET_HAS_GAP: true,
    TARGET_EFFECTIVE_COUNT_MISMATCH: true,
    OBSERVED_STRIP_HAS_GAP: true,
    STALE_ENTRIES_STATE: true,
  });

export function ledEntryPlanRefusalMessage(refusal: LedEntryPlanRefusalId): LedPhrase {
  return phrase(`${NS}.save.entryPlan.${refusal}`);
}

export type LedGroupStateId = 'PENDING' | 'APPLIED_ACK' | 'READBACK_VERIFIED';

export const LED_GROUP_STATE_IDS: Readonly<Record<LedGroupStateId, true>> = Object.freeze({
  PENDING: true,
  APPLIED_ACK: true,
  READBACK_VERIFIED: true,
});

export function ledGroupStateLabel(state: LedGroupStateId): LedPhrase {
  return phrase(`${NS}.save.groupState.${state}`);
}

/** The four write phases the save runs through, said in Arabic while they
 *  happen instead of one indeterminate spinner. */
export function ledSaveProgressLabel(group: LedSaveGroup): LedPhrase {
  return phrase(`${NS}.save.progress`, {group: `${NS}.save.group.${group}`});
}
