/* eslint-disable no-bitwise -- the reserved-overlay assertions build the
 * firmware's own bit masks, which is the thing under test. */
/**
 * THE PRESENTATION LAYER SAYS WHAT IS TRUE, AND SAYS IT AS A KEY.
 *
 * Two classes of assertion here, and the second is the one that earns its
 * keep:
 *
 *  1. The right key for the right fact - an unknown function carries its
 *     number, a palette slot is numbered rather than named, the inert
 *     flight mode is marked inert.
 *
 *  2. UNION DRIFT. This module deliberately restates the controller's
 *     result unions instead of importing them, so that `core/` keeps no
 *     dependency on `platforms/`. The tests below import BOTH sides and
 *     compare them, which is what makes that restatement safe: add a
 *     result kind to the controller and this file fails until the
 *     presentation layer has a sentence for it.
 */

import {
  LED_BASE_FUNCTION_IDS,
  LED_BLOCK_REASON_IDS,
  LED_DIRECTION_BITS,
  LED_DIRECTION_IDS,
  LED_EDIT_REFUSAL_IDS,
  LED_ENTRY_PLAN_REFUSAL_IDS,
  LED_GROUP_STATE_IDS,
  LED_LAYER_DISPLAY_ORDER,
  LED_LOAD_OUTCOME_IDS,
  LED_MODE_IDS,
  LED_OVERLAY_IDS,
  LED_SAVE_BLOCKER_IDS,
  LED_SAVE_OUTCOME_IDS,
  LED_SAVE_REFUSAL_IDS,
  LED_SPECIAL_SLOT_IDS,
  LED_TOGGLEABLE_OVERLAY_BITS,
  ledBaseFunctionLabel,
  ledBlockReasonMessage,
  ledCapabilityNotice,
  ledClusterBadge,
  ledDirectionLabel,
  ledEditingAllowed,
  ledEffectiveDirectionNote,
  ledGridCaption,
  ledModeRuntimeNote,
  ledNodeLabel,
  ledOverlayLabel,
  ledPaletteSlotLabel,
  ledReadOnlyNotice,
  ledReservedOverlayNotice,
  ledSaveOutcomeSeverity,
  ledSaveRequiresReload,
  ledSpecialSlotLabel,
  type LedSaveOutcomeId,
} from './ledStripPresentation';
import {LED_LAYER_PRIORITY_ORDER} from './ledStripModel';
import type {
  LedGroupState,
  LedSaveRefusal,
  LedStripBlockReason,
  LedStripLoadOutcome,
  LedStripSaveOutcome,
} from '../../platforms/react-native/protocol/LedStripConfigurationController';
import type {LedEntryPlanRefusal} from './ledStripSaveModel';

/* ================================================================== *
 * BASE FUNCTIONS
 * ================================================================== */

describe('base functions', () => {
  it('names each of the ten defined values', () => {
    for (let value = 0; value < 10; value++) {
      expect(ledBaseFunctionLabel(value)).toEqual({
        key: `ledStripScreen.function.${LED_BASE_FUNCTION_IDS[value]}`,
      });
    }
  });

  it('carries the NUMBER of a function this build does not know', () => {
    expect(ledBaseFunctionLabel(14)).toEqual({
      key: 'ledStripScreen.function.unknown',
      params: {value: 14},
    });
  });

  it('never normalises an unknown value into a known one', () => {
    /* `baseFunction % 10` would turn 14 into 4 (RSSI) and 10 into 0
       (COLOR). Both must stay unknown, and must stay distinguishable. */
    expect(ledBaseFunctionLabel(14).params).toEqual({value: 14});
    expect(ledBaseFunctionLabel(10).params).toEqual({value: 10});
    expect(ledBaseFunctionLabel(14)).not.toEqual(ledBaseFunctionLabel(4));
    expect(ledBaseFunctionLabel(10)).not.toEqual(ledBaseFunctionLabel(0));
  });

  it('offers the ten values in wire order, so the index IS the value', () => {
    expect(LED_BASE_FUNCTION_IDS).toHaveLength(10);
    expect(LED_BASE_FUNCTION_IDS[0]).toBe('COLOR');
    expect(LED_BASE_FUNCTION_IDS[1]).toBe('FLIGHT_MODE');
    expect(LED_BASE_FUNCTION_IDS[6]).toBe('THRUST_RING');
    expect(LED_BASE_FUNCTION_IDS[9]).toBe('ALTITUDE');
  });
});

/* ================================================================== *
 * OVERLAYS AND DIRECTIONS
 * ================================================================== */

describe('overlays', () => {
  it('names the seven defined bits in bit order', () => {
    expect(LED_TOGGLEABLE_OVERLAY_BITS).toEqual([0, 1, 2, 3, 4, 5, 6]);
    LED_TOGGLEABLE_OVERLAY_BITS.forEach((bit, i) => {
      expect(ledOverlayLabel(bit)).toEqual({key: `ledStripScreen.overlay.${LED_OVERLAY_IDS[i]}`});
    });
  });

  it('says reserved bits exist and will be kept, without calling them an error', () => {
    expect(ledReservedOverlayNotice(0b0000000001)).toBeUndefined();
    expect(ledReservedOverlayNotice(0b1111111111)).toEqual({
      key: 'ledStripScreen.overlay.reservedPreserved',
    });
    for (const bit of [7, 8, 9]) {
      expect(ledReservedOverlayNotice(1 << bit)).toBeDefined();
    }
  });
});

describe('directions', () => {
  it('names all six bits in the order the firmware searches them', () => {
    expect(LED_DIRECTION_BITS).toEqual([0, 1, 2, 3, 4, 5]);
    expect(LED_DIRECTION_IDS).toEqual(['NORTH', 'EAST', 'SOUTH', 'WEST', 'UP', 'DOWN']);
    expect(ledDirectionLabel(0)).toEqual({key: 'ledStripScreen.direction.NORTH'});
    expect(ledDirectionLabel(5)).toEqual({key: 'ledStripScreen.direction.DOWN'});
  });

  it('says which direction wins when a flight-mode LED has more than one', () => {
    /* EAST(1) and WEST(3) both set: the firmware stops at the lowest bit. */
    expect(ledEffectiveDirectionNote(1, 0b001010)).toEqual({
      key: 'ledStripScreen.direction.firstWins',
      params: {direction: 'ledStripScreen.direction.EAST'},
    });
  });

  it('stays quiet when exactly one direction is set', () => {
    expect(ledEffectiveDirectionNote(1, 0b000100)).toBeUndefined();
  });

  it('says a flight-mode LED with no direction takes no mode colour', () => {
    expect(ledEffectiveDirectionNote(1, 0)).toEqual({
      key: 'ledStripScreen.direction.noneChosen',
    });
  });

  it('says nothing about directions for a function that does not use them', () => {
    for (const fn of [0, 2, 3, 6, 9]) {
      expect(ledEffectiveDirectionNote(fn, 0b001010)).toBeUndefined();
    }
  });
});

/* ================================================================== *
 * PALETTE AND MODES
 * ================================================================== */

describe('the palette', () => {
  it('NUMBERS slots and never names them', () => {
    expect(ledPaletteSlotLabel(0)).toEqual({
      key: 'ledStripScreen.palette.slot',
      params: {number: 1},
    });
    expect(ledPaletteSlotLabel(15)).toEqual({
      key: 'ledStripScreen.palette.slot',
      params: {number: 16},
    });
  });

  it('has no key that could carry a colour name', () => {
    const keys = Array.from({length: 16}, (_u, slot) => ledPaletteSlotLabel(slot).key);
    expect(new Set(keys).size).toBe(1);
    for (const name of ['black', 'white', 'red', 'green', 'blue', 'cyan', 'magenta', 'yellow']) {
      expect(keys[0].toLowerCase()).not.toContain(name);
    }
  });
});

describe('flight modes', () => {
  it('names the six wire modes', () => {
    expect(LED_MODE_IDS).toEqual([
      'ORIENTATION',
      'HEADFREE',
      'HORIZON',
      'ANGLE',
      'MAG',
      'BARO',
    ]);
  });

  it('marks mode 5 as stored but never read, instead of showing it as active', () => {
    expect(ledModeRuntimeNote(5)).toEqual({
      key: 'ledStripScreen.mode.runtime.KNOWN_BUT_RUNTIME_INERT',
    });
  });

  it('marks the compass mode as build-conditional', () => {
    expect(ledModeRuntimeNote(4)).toEqual({
      key: 'ledStripScreen.mode.runtime.RUNTIME_MAPPED_WHEN_BUILT',
    });
  });

  it('says nothing about the four modes that simply work', () => {
    for (const mode of [0, 1, 2, 3]) {
      expect(ledModeRuntimeNote(mode)).toBeUndefined();
    }
  });
});

describe('special colour slots', () => {
  it('names the eight the firmware names, BACKGROUND included', () => {
    expect(LED_SPECIAL_SLOT_IDS).toHaveLength(8);
    expect(LED_SPECIAL_SLOT_IDS[3]).toBe('BACKGROUND');
    expect(ledSpecialSlotLabel(3)).toEqual({key: 'ledStripScreen.special.BACKGROUND'});
  });

  it('lists slots 8, 9 and 10 as unknown-but-preserved rather than dropping them', () => {
    for (const slot of [8, 9, 10]) {
      expect(ledSpecialSlotLabel(slot)).toEqual({
        key: 'ledStripScreen.special.unknownPreserved',
        params: {slot},
      });
    }
  });

  it('refuses a slot the frame does not carry', () => {
    expect(ledSpecialSlotLabel(11).key).toBe('ledStripScreen.special.outOfRange');
  });
});

/* ================================================================== *
 * LAYER PRIORITY
 * ================================================================== */

describe('layer priority', () => {
  it('shows the highest-priority layer first, warnings at the top', () => {
    expect(LED_LAYER_DISPLAY_ORDER[0]).toBe('WARNING');
    expect(LED_LAYER_DISPLAY_ORDER[LED_LAYER_DISPLAY_ORDER.length - 1]).toBe('BASE_FUNCTION');
  });

  it('is exactly the firmware order, reversed and nothing else', () => {
    expect([...LED_LAYER_DISPLAY_ORDER].reverse()).toEqual([...LED_LAYER_PRIORITY_ORDER]);
  });
});

/* ================================================================== *
 * THE GRID
 * ================================================================== */

describe('the grid presents itself as a layout, not as a live view', () => {
  it('captions itself as a symbolic preview', () => {
    expect(ledGridCaption()).toEqual({key: 'ledStripScreen.grid.symbolicPreview'});
  });

  it('numbers an LED from one while the index stays the wire index', () => {
    expect(ledNodeLabel(0)).toEqual({
      key: 'ledStripScreen.grid.ledNumber',
      params: {number: 1},
    });
    expect(ledNodeLabel(31).params).toEqual({number: 32});
  });

  it('counts a shared cell instead of merging it', () => {
    expect(ledClusterBadge(2)).toEqual({
      key: 'ledStripScreen.grid.cluster',
      params: {count: 2},
    });
  });
});

describe('capability', () => {
  it('says nothing on a board with the status-mode build', () => {
    expect(ledCapabilityNotice('ADVANCED_STATUS_MODE')).toBeUndefined();
  });

  it('names the limitation on a basic board and on an unrecognised byte', () => {
    expect(ledCapabilityNotice('BASIC_LED_STRIP')).toEqual({
      key: 'ledStripScreen.capability.BASIC_LED_STRIP',
    });
    expect(ledCapabilityNotice('UNRECOGNISED_CAPABILITY_BYTE')).toEqual({
      key: 'ledStripScreen.capability.UNRECOGNISED_CAPABILITY_BYTE',
    });
  });
});

/* ================================================================== *
 * SAVE STATES
 * ================================================================== */

describe('save outcomes are graded, not collapsed', () => {
  it('calls a verified save a success and nothing else', () => {
    const successes = (Object.keys(LED_SAVE_OUTCOME_IDS) as LedSaveOutcomeId[]).filter(
      id => ledSaveOutcomeSeverity(id) === 'SUCCESS',
    );
    expect(successes).toEqual(['SAVE_VERIFIED']);
  });

  it('does NOT call an applied-but-unpersisted save a success', () => {
    expect(ledSaveOutcomeSeverity('APPLIED_NOT_PERSISTED')).toBe('ATTENTION');
    expect(ledSaveOutcomeSeverity('PARTIAL_APPLY')).toBe('ATTENTION');
    expect(ledSaveOutcomeSeverity('READBACK_MISMATCH')).toBe('ATTENTION');
  });

  it('treats "nothing to do" as information rather than as a problem', () => {
    expect(ledSaveOutcomeSeverity('NO_CHANGES')).toBe('INFORMATION');
  });

  it('forces a re-read after anything that half-applied', () => {
    expect(ledSaveRequiresReload('PARTIAL_APPLY')).toBe(true);
    expect(ledSaveRequiresReload('READBACK_MISMATCH')).toBe(true);
    expect(ledSaveRequiresReload('APPLIED_NOT_PERSISTED')).toBe(true);
    expect(ledSaveRequiresReload('SESSION_LOST_DURING_SAVE')).toBe(true);
  });

  it('does not force a re-read after a save that wrote nothing', () => {
    expect(ledSaveRequiresReload('REFUSED')).toBe(false);
    expect(ledSaveRequiresReload('REJECTED')).toBe(false);
    expect(ledSaveRequiresReload('NO_CHANGES')).toBe(false);
    expect(ledSaveRequiresReload('SAVE_VERIFIED')).toBe(false);
  });
});

describe('a future firmware is read-only, not broken', () => {
  it('blocks editing for every block reason, including the future-API one', () => {
    for (const reason of Object.keys(LED_BLOCK_REASON_IDS)) {
      expect(ledEditingAllowed(reason as never)).toBe(false);
      expect(ledBlockReasonMessage(reason as never).key).toBe(
        `ledStripScreen.blocked.${reason}`,
      );
    }
    expect(ledEditingAllowed(undefined)).toBe(true);
  });

  it('explains the future-API case as read-only rather than as a failure', () => {
    expect(ledReadOnlyNotice('UNVERIFIED_FUTURE_API')).toEqual({
      key: 'ledStripScreen.blocked.futureApiReadOnly',
    });
    expect(ledReadOnlyNotice('DISCONNECTED')).toBeUndefined();
    expect(ledReadOnlyNotice(undefined)).toBeUndefined();
  });
});

/* ================================================================== *
 * UNION DRIFT - the guard that makes the restated unions safe
 * ================================================================== */

describe('the restated unions match the controller exactly', () => {
  /* Each assignment below is checked by the COMPILER in both directions:
     a member the controller adds has no home in the presentation record,
     and a member the presentation invents has no home in the controller's
     union. `npx tsc --noEmit` fails before this test ever runs. */

  it('covers every block reason', () => {
    const fromController: Record<LedStripBlockReason, true> = LED_BLOCK_REASON_IDS;
    const backAgain: Record<keyof typeof LED_BLOCK_REASON_IDS, true> = fromController;
    expect(Object.keys(backAgain)).toHaveLength(8);
  });

  it('covers every load outcome', () => {
    const kinds: Record<LedStripLoadOutcome['kind'], true> = LED_LOAD_OUTCOME_IDS;
    const backAgain: Record<keyof typeof LED_LOAD_OUTCOME_IDS, true> = kinds;
    expect(Object.keys(backAgain).sort()).toEqual(
      ['CAPABILITY_CONTRADICTION', 'FAILED', 'LOADED', 'REJECTED', 'SESSION_ENDED'].sort(),
    );
  });

  it('covers every save outcome', () => {
    const kinds: Record<LedStripSaveOutcome['kind'], true> = LED_SAVE_OUTCOME_IDS;
    const backAgain: Record<keyof typeof LED_SAVE_OUTCOME_IDS, true> = kinds;
    expect(Object.keys(backAgain)).toHaveLength(10);
  });

  it('covers every save refusal', () => {
    const kinds: Record<LedSaveRefusal['kind'], true> = LED_SAVE_REFUSAL_IDS;
    const backAgain: Record<keyof typeof LED_SAVE_REFUSAL_IDS, true> = kinds;
    expect(Object.keys(backAgain)).toHaveLength(8);
  });

  it('covers every entry-plan refusal', () => {
    const kinds: Record<LedEntryPlanRefusal['kind'], true> = LED_ENTRY_PLAN_REFUSAL_IDS;
    const backAgain: Record<keyof typeof LED_ENTRY_PLAN_REFUSAL_IDS, true> = kinds;
    expect(Object.keys(backAgain)).toHaveLength(6);
  });

  it('covers every per-group state', () => {
    const kinds: Record<LedGroupState, true> = LED_GROUP_STATE_IDS;
    const backAgain: Record<keyof typeof LED_GROUP_STATE_IDS, true> = kinds;
    expect(Object.keys(backAgain)).toHaveLength(3);
  });

  it('covers every editor refusal and every save blocker', () => {
    expect(Object.keys(LED_EDIT_REFUSAL_IDS)).toHaveLength(9);
    expect(Object.keys(LED_SAVE_BLOCKER_IDS)).toHaveLength(5);
  });
});
