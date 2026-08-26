/* eslint-disable no-bitwise -- scenario LEDs are built from firmware bit
 * positions, and reserved-bit assertions mask them back out. */
/**
 * THE LED CONTROLLER, DRIVEN THROUGH THE REAL STACK.
 *
 * Every scenario below runs the actual `LedStripConfigurationController`
 * against a `VirtualLedBoard` that re-counts its strip after every accepted
 * write, exactly as the firmware does. Nothing is mocked between them: the
 * real operation coordinator, the real session guards, the real encoders and
 * the real decoders all sit in the path.
 *
 * The assertions that matter most are not on the final state. They are on
 * the board's own trace of what it looked like BETWEEN writes, because a
 * save that briefly truncates the strip and a save that never does end up
 * identical if you only look at the end.
 */

import {
  LedStripConfigurationController,
  type LedStripSaveRequest,
  type LedStripSnapshot,
} from './LedStripConfigurationController';
import {VirtualSession} from './__testUtils__/virtualSession';
import {LED_CMD, VirtualLedBoard, type VirtualLedBoardOptions} from './__testUtils__/virtualLedBoard';
import {
  decodeLedEntry,
  encodeLedEntry,
  LedBaseFunction,
  LedDirectionBit,
  LedOverlayBit,
  withLedColorIndex,
} from '../../../core/protocol/msp/decoding/ledStripWireContract';

/* ------------------------------------------------------------------ *
 * SCENARIO PLUMBING
 * ------------------------------------------------------------------ */

/** A distinguishable, never-zero LED word. */
function led(params: {
  x: number;
  y: number;
  fn?: number;
  overlays?: number;
  color?: number;
  directions?: number;
}): number {
  return encodeLedEntry({
    x: params.x,
    y: params.y,
    baseFunction: params.fn ?? LedBaseFunction.COLOR,
    overlayMask: params.overlays ?? 0,
    colorIndex: params.color ?? 1,
    directionMask: params.directions ?? 1 << LedDirectionBit.NORTH,
  });
}

/** Four LEDs at the corners of a small box. */
const FOUR: readonly number[] = Object.freeze([
  led({x: 2, y: 1, color: 1}),
  led({x: 6, y: 1, color: 2}),
  led({x: 2, y: 5, color: 3}),
  led({x: 6, y: 5, color: 4}),
]);

function makeBoard(options: Partial<VirtualLedBoardOptions> = {}): VirtualLedBoard {
  return new VirtualLedBoard({
    maxLength: 32,
    advancedRaw: 1,
    profile: 2,
    entries: FOUR,
    ...options,
  });
}

function makeSession(board: VirtualLedBoard, apiMinor = 48) {
  return new VirtualSession({sessionId: 'led-1', board: board as never, apiMinor});
}

function makeController(session: VirtualSession): LedStripConfigurationController {
  return new LedStripConfigurationController({
    coordinator: session.coordinator as never,
    appStateOwner: {getPhase: () => session.appPhase as 'ACTIVE'},
  });
}

async function loadOrThrow(
  controller: LedStripConfigurationController,
  session: VirtualSession,
): Promise<LedStripSnapshot> {
  const outcome = await controller.load(session.key);
  if (outcome.kind !== 'LOADED') {
    throw new Error(`expected LOADED, got ${outcome.kind}`);
  }
  return outcome.snapshot;
}

/** The four SET commands and the persist, all of which must be zero on a
 *  load and on any refusal. */
function writeCounts(board: VirtualLedBoard) {
  return {
    entries: board.countOf(LED_CMD.SET_STRIP_CONFIG),
    palette: board.countOf(LED_CMD.SET_COLORS),
    modeColors: board.countOf(LED_CMD.SET_MODECOLOR),
    runtimeValues: board.countOf(LED_CMD.SET_VALUES),
    eeprom: board.countOf(LED_CMD.EEPROM),
    reboots: board.countOf(LED_CMD.REBOOT),
  };
}

const NO_WRITES = {entries: 0, palette: 0, modeColors: 0, runtimeValues: 0, eeprom: 0, reboots: 0};

/** A full-length target array built from a prefix. */
function target(board: VirtualLedBoard, prefix: readonly number[]): number[] {
  return Array.from({length: board.maxLength}, (_unused, i) => prefix[i] ?? 0);
}

/* ================================================================== *
 * 1-2, 30, 61-62. LOAD
 * ================================================================== */

describe('load reads and never writes', () => {
  it('1. loads a basic build without asking for advanced commands', async () => {
    const board = makeBoard({advancedRaw: 0});
    const session = makeSession(board);
    const snapshot = await loadOrThrow(makeController(session), session);

    expect(snapshot.capability).toBe('BASIC_LED_STRIP');
    expect(snapshot.advancedRaw).toBe(0);
    /* Not empty arrays - absent. A basic build has no palette to show, and
       sixteen invented black slots would be an editable lie. */
    expect(snapshot.palette).toBeUndefined();
    expect(snapshot.modeColors).toBeUndefined();
    /* Proven by the board's own counters, not by inspection of the result. */
    expect(board.countOf(LED_CMD.COLORS)).toBe(0);
    expect(board.countOf(LED_CMD.MODECOLOR)).toBe(0);
    expect(board.countOf(LED_CMD.STRIP_CONFIG)).toBe(1);
    expect(board.countOf(LED_CMD.GET_VALUES)).toBe(1);
  });

  it('2. loads an advanced build with every resource group', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const snapshot = await loadOrThrow(makeController(session), session);

    expect(snapshot.capability).toBe('ADVANCED_STATUS_MODE');
    expect(snapshot.entries).toHaveLength(32);
    expect(snapshot.palette).toHaveLength(16);
    expect(snapshot.modeColors).toHaveLength(48);
    expect(snapshot.profile).toBe(2);
    expect(snapshot.truth.effectiveCount).toBe(4);
    expect(snapshot.runtimeValues).toEqual({brightness: 50, rainbowDelta: 0, rainbowFreq: 120});
  });

  it('30. sends ZERO writes on load, for every build type', async () => {
    /* This is the permanent guard against the reference tab's habit of
       pushing its own defaults at the board the moment it opens. */
    for (const advancedRaw of [0, 1]) {
      const board = makeBoard({advancedRaw, brightness: 77, rainbowFreq: 999});
      const session = makeSession(board);
      await loadOrThrow(makeController(session), session);
      expect(writeCounts(board)).toEqual(NO_WRITES);
    }
  });

  it('reports a board with no LED support at all, and writes nothing', async () => {
    const board = makeBoard({ledStripAbsent: true});
    const session = makeSession(board);
    const outcome = await makeController(session).load(session.key);
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'LED_STRIP_UNSUPPORTED_BY_BUILD'});
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('reports a capability contradiction rather than degrading quietly', async () => {
    const board = makeBoard();
    board.injectFault({command: LED_CMD.COLORS, fault: {kind: 'REMOTE_ERROR'}});
    const session = makeSession(board);
    const outcome = await makeController(session).load(session.key);
    expect(outcome.kind).toBe('CAPABILITY_CONTRADICTION');
    if (outcome.kind !== 'CAPABILITY_CONTRADICTION') return;
    expect(outcome.resource).toBe('PALETTE');
    /* The basic part of what was read is still true and is handed back. */
    expect(outcome.partial?.entries).toHaveLength(32);
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('does NOT turn a link timeout into "feature unsupported"', async () => {
    const board = makeBoard();
    board.injectFault({command: LED_CMD.COLORS, fault: {kind: 'TIMEOUT'}});
    const session = makeSession(board);
    const outcome = await makeController(session).load(session.key);
    /* Silence is not an answer about capability. */
    expect(outcome.kind).not.toBe('CAPABILITY_CONTRADICTION');
    expect(['FAILED', 'SESSION_ENDED']).toContain(outcome.kind);
  });
});

/* ================================================================== *
 * 3-5. STRIP LENGTH
 * ================================================================== */

describe('strip length comes from the board', () => {
  it.each([
    ['3. thirty-two', 32],
    ['4. sixty-four', 64],
    ['5. a target-defined twenty', 20],
  ])('%s', async (_label, maxLength) => {
    const board = makeBoard({maxLength});
    const session = makeSession(board);
    const snapshot = await loadOrThrow(makeController(session), session);
    expect(snapshot.maxLength).toBe(maxLength);
    expect(snapshot.entries).toHaveLength(maxLength);
  });

  it('writes an index the board would accept, at a non-standard length', async () => {
    const board = makeBoard({maxLength: 20});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    const next = target(board, [...FOUR, led({x: 9, y: 9, color: 5})]);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});
    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.effectiveCount()).toBe(5);
  });
});

/* ================================================================== *
 * 8-10, 54-56. THE ENTRY WRITE PLANNER
 * ================================================================== */

describe('entry writes are changed-only and safely ordered', () => {
  it('8. one edited LED costs exactly one write, not thirty-two', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const next = target(board, FOUR);
    next[2] = withLedColorIndex(FOUR[2], 11);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.stripWrites).toBe(1);
    expect(board.trace).toHaveLength(1);
    expect(board.trace[0].index).toBe(2);
    expect(board.readEntries()[2]).toBe(next[2]);
    expect(board.counts.eepromWrites).toBe(1);
  });

  it('9/54. extension writes ascending from the old terminator', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const next = target(board, [
      ...FOUR,
      led({x: 3, y: 3, color: 5}),
      led({x: 4, y: 4, color: 6}),
    ]);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next, declaredEffectiveCount: 6},
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.trace.map(step => step.index)).toEqual([4, 5]);
    /* At no intermediate moment is a configured LED stranded past a
       terminator: the count climbs 4 -> 5 -> 6 and never sees a gap. */
    expect(board.trace.map(step => step.effectiveCount)).toEqual([5, 6]);
    expect(board.trace.every(step => !step.gapDetected)).toBe(true);
    expect(board.effectiveCount()).toBe(6);
  });

  it('10/55. shrink commits one terminator, then cleans the tail', async () => {
    const six = [...FOUR, led({x: 3, y: 3, color: 5}), led({x: 4, y: 4, color: 6})];
    const board = makeBoard({entries: six});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    expect(observed.truth.effectiveCount).toBe(6);

    const next = target(board, FOUR);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next, declaredEffectiveCount: 4},
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    /* Index 4 first - the deliberate commit point. Clearing index 5 first
       would have walked the strip through a count of five nobody chose. */
    expect(board.trace.map(step => step.index)).toEqual([4, 5]);
    expect(board.trace[0].effectiveCount).toBe(4);
    expect(board.trace.map(step => step.effectiveCount)).toEqual([4, 4]);
    expect(board.effectiveCount()).toBe(4);
    /* And the raw array is canonical afterwards, not carrying old words. */
    expect(board.readEntries().slice(4).every(word => word === 0)).toBe(true);
  });

  it('a shrink never zeroes a higher tail index before the new terminator', async () => {
    const eight = [
      ...FOUR,
      led({x: 3, y: 3, color: 5}),
      led({x: 4, y: 4, color: 6}),
      led({x: 5, y: 5, color: 7}),
      led({x: 6, y: 6, color: 8}),
    ];
    const board = makeBoard({entries: eight});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    await controller.save(session.key, {
      observed,
      entries: {target: target(board, FOUR), declaredEffectiveCount: 4},
    });

    const zeroWrites = board.trace.filter(step => step.raw === 0).map(step => step.index);
    expect(zeroWrites[0]).toBe(4);
    expect(zeroWrites).toEqual([4, 5, 6, 7]);
  });

  it('7/59. refuses to write over a board that already has a gap', async () => {
    const holed = [FOUR[0], 0, FOUR[2], 0];
    const board = makeBoard({entries: holed});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    /* The load reports the truth rather than hiding it. */
    expect(observed.truth.gapDetected).toBe(true);
    expect(observed.truth.effectiveCount).toBe(1);
    expect(observed.truth.unreachableEntries.map(e => e.index)).toEqual([2]);

    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: target(board, FOUR)},
    });
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.refusal.kind).toBe('ENTRY_PLAN_REFUSED');
    /* Not one write, and no silent repair of a state nobody chose. */
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('67. refuses when an entry nobody edited moved underneath the draft', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.externallySetEntry(3, led({x: 12, y: 12, color: 9}));

    const next = target(board, FOUR);
    next[1] = withLedColorIndex(FOUR[1], 7);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});

    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.refusal).toEqual({
      kind: 'ENTRY_PLAN_REFUSED',
      refusal: {kind: 'STALE_ENTRIES_STATE', firstDivergentIndex: 3},
    });
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });
});

/* ================================================================== *
 * 6, 11, 57-58. WHAT MUST SURVIVE A SAVE
 * ================================================================== */

describe('board state this build does not own is preserved', () => {
  it('6/58. keeps two LEDs that share one coordinate', async () => {
    const duplicates = [
      led({x: 4, y: 4, color: 1}),
      led({x: 4, y: 4, color: 2, fn: LedBaseFunction.ARM_STATE}),
      led({x: 9, y: 1, color: 3}),
    ];
    const board = makeBoard({entries: duplicates});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    expect(observed.truth.effectiveCount).toBe(3);
    expect(observed.truth.duplicatePositions).toEqual([{x: 4, y: 4, indexes: [0, 1]}]);

    /* Editing one of the pair touches only that one. */
    const next = target(board, duplicates);
    next[1] = withLedColorIndex(duplicates[1], 12);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.stripWrites).toBe(1);
    expect(board.readEntries()[0]).toBe(duplicates[0]);
    expect(decodeLedEntry(board.readEntries()[1], 1).colorIndex).toBe(12);
    expect(decodeLedEntry(board.readEntries()[1], 1).x).toBe(4);
    expect(decodeLedEntry(board.readEntries()[1], 1).y).toBe(4);
  });

  it('11/57. carries a reserved overlay bit through a colour-only edit', async () => {
    /* Bit 8 of the ten-bit overlay field has no defined meaning. It must
       come back off the board untouched after a save that changed only the
       colour nibble - end to end, through the real encoder and decoder. */
    const withReserved = led({
      x: 7,
      y: 2,
      overlays: (1 << LedOverlayBit.BLINK) | (1 << 8),
      color: 3,
    });
    const board = makeBoard({entries: [withReserved, FOUR[1]]});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    expect(observed.entries[0].overlayMask & 0x380).toBe(0x100);

    const next = target(board, [withLedColorIndex(withReserved, 14), FOUR[1]]);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    const after = decodeLedEntry(board.readEntries()[0], 0);
    expect(after.colorIndex).toBe(14);
    expect(after.overlayMask).toBe((1 << LedOverlayBit.BLINK) | (1 << 8));
    expect(after.overlayMask & 0x380).toBe(0x100);
  });

  it('carries an unknown base-function value through a save', async () => {
    const unknownFn = encodeLedEntry({
      x: 1,
      y: 2,
      baseFunction: 14,
      overlayMask: 0,
      colorIndex: 1,
      directionMask: 0,
    });
    const board = makeBoard({entries: [unknownFn, FOUR[1]]});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    expect(observed.entries[0].baseFunction).toBe(14);

    const next = target(board, [unknownFn, withLedColorIndex(FOUR[1], 9)]);
    await controller.save(session.key, {observed, entries: {target: next}});
    expect(decodeLedEntry(board.readEntries()[0], 0).baseFunction).toBe(14);
  });
});

/* ================================================================== *
 * 12-14, 65-66. PALETTE
 * ================================================================== */

describe('palette saves are whole-frame but never stale', () => {
  it('12. writes one edited slot and reads it back', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const outcome = await controller.save(session.key, {
      observed,
      palette: new Map([[3, {hue: 200, whiteness: 5, value: 250}]]),
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.paletteWrites).toBe(1);
    expect(board.readPalette()[3]).toEqual({hue: 200, whiteness: 5, value: 250});
    expect(board.counts.stripWrites).toBe(0);
    expect(board.counts.eepromWrites).toBe(1);
  });

  it('13/65. preserves a slot somebody else changed while the screen was open', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.externallySetPaletteSlot(8, {hue: 99, whiteness: 1, value: 2});

    const outcome = await controller.save(session.key, {
      observed,
      palette: new Map([[3, {hue: 200, whiteness: 5, value: 250}]]),
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.readPalette()[3]).toEqual({hue: 200, whiteness: 5, value: 250});
    /* Rebuilding the frame from the stale snapshot would have reverted this
       and the save would still have looked perfect. */
    expect(board.readPalette()[8]).toEqual({hue: 99, whiteness: 1, value: 2});
  });

  it('14/66. refuses when the edited slot itself moved', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.externallySetPaletteSlot(3, {hue: 11, whiteness: 22, value: 33});

    const outcome = await controller.save(session.key, {
      observed,
      palette: new Map([[3, {hue: 200, whiteness: 5, value: 250}]]),
    });

    expect(outcome).toEqual({kind: 'REFUSED', refusal: {kind: 'STALE_PALETTE_SLOT', slot: 3}});
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('44. refuses a palette save on a basic build, before any write', async () => {
    const board = makeBoard({advancedRaw: 0});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const outcome = await controller.save(session.key, {
      observed,
      palette: new Map([[3, {hue: 1, whiteness: 2, value: 3}]]),
    });

    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.refusal).toEqual({
      kind: 'ADVANCED_LED_STATUS_UNAVAILABLE',
      groups: ['PALETTE'],
    });
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });
});

/* ================================================================== *
 * 15-19, 64. MODE COLOURS
 * ================================================================== */

describe('mode colours are changed-tuple only', () => {
  it('15. writes exactly one tuple', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const outcome = await controller.save(session.key, {
      observed,
      modeColors: [{mode: 2, slot: 3, value: 9}],
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.modeColorWrites).toBe(1);
    expect(board.readTuples().find(t => t.mode === 2 && t.slot === 3)?.value).toBe(9);
  });

  it('16. writes several tuples and leaves the other forty-five alone', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    const before = board.readTuples();

    const outcome = await controller.save(session.key, {
      observed,
      modeColors: [
        {mode: 0, slot: 0, value: 5},
        {mode: 1, slot: 4, value: 6},
        {mode: 6, slot: 2, value: 7},
      ],
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.modeColorWrites).toBe(3);
    const after = board.readTuples();
    const touched = new Set(['0:0', '1:4', '6:2']);
    for (const tuple of after) {
      const key = `${tuple.mode}:${tuple.slot}`;
      if (touched.has(key)) continue;
      expect(tuple.value).toBe(before.find(t => t.mode === tuple.mode && t.slot === tuple.slot)?.value);
    }
  });

  it('18. never writes the three unnamed special slots, so they survive', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    const before = board.readTuples();
    const unnamedBefore = before.filter(t => t.mode === 6 && t.slot >= 8);
    expect(unnamedBefore).toHaveLength(3);

    await controller.save(session.key, {observed, modeColors: [{mode: 0, slot: 0, value: 5}]});

    const unnamedAfter = board.readTuples().filter(t => t.mode === 6 && t.slot >= 8);
    expect(unnamedAfter).toEqual(unnamedBefore);
  });

  it('19. saves the aux tuple as a channel, not a colour', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const outcome = await controller.save(session.key, {
      observed,
      modeColors: [{mode: 7, slot: 0, value: 6}],
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.readTuples().find(t => t.mode === 7)?.value).toBe(6);
    /* And the mode-5 tuples nobody touched are still exactly as they were:
       wire-known, runtime-inert, and never discarded. */
    expect(board.readTuples().filter(t => t.mode === 5)).toHaveLength(6);
  });

  it('20/17/64. reports a partial apply when a middle tuple fails', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.injectFault({
      command: LED_CMD.SET_MODECOLOR,
      fault: {kind: 'REMOTE_ERROR'},
      occurrence: 2,
    });

    const outcome = await controller.save(session.key, {
      observed,
      modeColors: [
        {mode: 0, slot: 0, value: 5},
        {mode: 1, slot: 1, value: 6},
        {mode: 2, slot: 2, value: 7},
      ],
    });

    expect(outcome.kind).toBe('PARTIAL_APPLY');
    if (outcome.kind !== 'PARTIAL_APPLY') return;
    expect(outcome.detail.appliedModeColors).toEqual([{mode: 0, slot: 0, value: 5}]);
    expect(outcome.detail.failedModeColor).toEqual({mode: 1, slot: 1, value: 6});
    /* The third was never attempted, and nothing was persisted. */
    expect(board.counts.modeColorWrites).toBe(1);
    expect(board.counts.eepromWrites).toBe(0);
    expect(outcome.detail.persistence).toBe('NOT_ATTEMPTED');
    expect(outcome.detail.observed).toBeDefined();
  });

  it('refuses a mode-colour save on a basic build', async () => {
    const board = makeBoard({advancedRaw: 0});
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    const outcome = await controller.save(session.key, {
      observed,
      modeColors: [{mode: 0, slot: 0, value: 1}],
    });
    expect(outcome.kind).toBe('REFUSED');
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });
});

/* ================================================================== *
 * 20-22, 68-69. RUNTIME VALUES
 * ================================================================== */

describe('runtime values patch the fresh board tuple', () => {
  it('20. writes brightness and reads it back', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const outcome = await controller.save(session.key, {
      observed,
      runtimeValues: {brightness: 80},
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.runtimeValueWrites).toBe(1);
    expect(board.readValues().brightness).toBe(80);
  });

  it('21/69. preserves a genuine zero the board reports', async () => {
    const board = makeBoard({brightness: 0, rainbowDelta: 0, rainbowFreq: 0});
    const session = makeSession(board);
    const snapshot = await loadOrThrow(makeController(session), session);
    /* `value || default` would have turned all three into invented numbers
       and then written them back. */
    expect(snapshot.runtimeValues).toEqual({brightness: 0, rainbowDelta: 0, rainbowFreq: 0});
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('22/68. keeps an external change to a field the operator did not edit', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.externallySetValues({rainbowFreq: 1500});

    const outcome = await controller.save(session.key, {
      observed,
      runtimeValues: {brightness: 90},
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.readValues()).toEqual({brightness: 90, rainbowDelta: 0, rainbowFreq: 1500});
  });

  it('refuses when the edited field itself moved', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    board.externallySetValues({brightness: 61});
    const outcome = await controller.save(session.key, {
      observed,
      runtimeValues: {brightness: 90},
    });
    expect(outcome).toEqual({
      kind: 'REFUSED',
      refusal: {kind: 'STALE_RUNTIME_VALUE', field: 'brightness'},
    });
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('accepts a frequency above the reference UI cap, per firmware source', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    const outcome = await controller.save(session.key, {
      observed,
      runtimeValues: {rainbowFreq: 1800},
    });
    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.readValues().rainbowFreq).toBe(1800);
  });
});

/* ================================================================== *
 * 23-26, 63. FAILURE TRUTH
 * ================================================================== */

describe('failures are reported as what they are', () => {
  it('24/63. a failed extension write is a partial apply, never a success', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.injectFault({
      command: LED_CMD.SET_STRIP_CONFIG,
      fault: {kind: 'REMOTE_ERROR'},
      entryIndex: 5,
    });

    const next = target(board, [
      ...FOUR,
      led({x: 3, y: 3, color: 5}),
      led({x: 4, y: 4, color: 6}),
    ]);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next, declaredEffectiveCount: 6},
    });

    expect(outcome.kind).toBe('PARTIAL_APPLY');
    if (outcome.kind !== 'PARTIAL_APPLY') return;
    expect(outcome.detail.appliedEntryIndexes).toEqual([4]);
    expect(outcome.detail.failedEntryIndex).toBe(5);
    expect(outcome.detail.failedEntryPhase).toBe('EXTEND');
    expect(outcome.detail.persistence).toBe('NOT_ATTEMPTED');
    /* The board really does have five now, and the result says so rather
       than claiming the six it was asked for. */
    expect(board.effectiveCount()).toBe(5);
    expect(outcome.detail.observed?.truth.effectiveCount).toBe(5);
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('23. an EEPROM failure is APPLIED_NOT_PERSISTED, not a save', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.injectFault({command: LED_CMD.EEPROM, fault: {kind: 'REMOTE_ERROR'}});

    const outcome = await controller.save(session.key, {
      observed,
      runtimeValues: {brightness: 66},
    });

    expect(outcome.kind).toBe('APPLIED_NOT_PERSISTED');
    if (outcome.kind !== 'APPLIED_NOT_PERSISTED') return;
    expect(outcome.groups.RUNTIME_VALUES).toBe('READBACK_VERIFIED');
    /* RAM holds it - saying "failed" would be a lie about the board's
       current behaviour, and saying "saved" a lie about a power cycle. */
    expect(board.readValues().brightness).toBe(66);
    expect(board.readPersistedEntries()).toEqual(board.readEntries());
    expect(outcome.snapshot?.runtimeValues.brightness).toBe(66);
  });

  it('25. a session loss mid-save stops, reports, and never persists', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    board.injectFault({
      command: LED_CMD.SET_STRIP_CONFIG,
      fault: {kind: 'SESSION_CLOSED'},
      entryIndex: 5,
    });

    const next = target(board, [
      ...FOUR,
      led({x: 3, y: 3, color: 5}),
      led({x: 4, y: 4, color: 6}),
    ]);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next, declaredEffectiveCount: 6},
    });

    expect(outcome.kind).toBe('SESSION_LOST_DURING_SAVE');
    if (outcome.kind !== 'SESSION_LOST_DURING_SAVE') return;
    expect(outcome.detail.appliedEntryIndexes).toEqual([4]);
    expect(outcome.detail.persistence).toBe('NOT_ATTEMPTED');
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('reports an ENTRY readback mismatch instead of persisting it', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    /* The write lands, and then an entry nobody wrote moves before the
       verification read. A per-index check would miss it entirely; the
       count, the ordinal animations and the quadrant boundaries would all
       have changed underneath the save. */
    const original = board.request.bind(board);
    let moved = false;
    board.request = async (command, payload, options) => {
      const result = await original(command, payload, options);
      if (command === LED_CMD.SET_STRIP_CONFIG && !moved) {
        moved = true;
        board.externallySetEntry(3, led({x: 15, y: 15, color: 15}));
      }
      return result;
    };

    const next = target(board, FOUR);
    next[0] = withLedColorIndex(FOUR[0], 13);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') return;
    expect(outcome.group).toBe('ENTRIES');
    expect(outcome.detail.persistence).toBe('NOT_ATTEMPTED');
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('reports a PALETTE readback mismatch instead of persisting it', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const original = board.request.bind(board);
    let moved = false;
    board.request = async (command, payload, options) => {
      const result = await original(command, payload, options);
      if (command === LED_CMD.SET_COLORS && !moved) {
        moved = true;
        board.externallySetPaletteSlot(3, {hue: 1, whiteness: 1, value: 1});
      }
      return result;
    };

    const outcome = await controller.save(session.key, {
      observed,
      palette: new Map([[3, {hue: 200, whiteness: 5, value: 250}]]),
    });

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') return;
    expect(outcome.group).toBe('PALETTE');
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('reports a MODE COLOUR readback mismatch instead of persisting it', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const original = board.request.bind(board);
    let moved = false;
    board.request = async (command, payload, options) => {
      const result = await original(command, payload, options);
      if (command === LED_CMD.SET_MODECOLOR && !moved) {
        moved = true;
        board.externallySetTuple(2, 3, 1);
      }
      return result;
    };

    const outcome = await controller.save(session.key, {
      observed,
      modeColors: [{mode: 2, slot: 3, value: 9}],
    });

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') return;
    expect(outcome.group).toBe('MODE_COLORS');
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('stops between entry writes when the session moves underneath it', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    /* The link still answers; it is the SESSION that changed. Only the
       liveness re-check between writes catches this, and continuing would
       push the rest of the strip onto whatever is there now. */
    const original = board.request.bind(board);
    let flipped = false;
    board.request = async (command, payload, options) => {
      const result = await original(command, payload, options);
      if (command === LED_CMD.SET_STRIP_CONFIG && !flipped) {
        flipped = true;
        session.generation += 1;
      }
      return result;
    };

    const next = target(board, [
      ...FOUR,
      led({x: 3, y: 3, color: 5}),
      led({x: 4, y: 4, color: 6}),
    ]);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next, declaredEffectiveCount: 6},
    });

    expect(outcome.kind).toBe('SESSION_LOST_DURING_SAVE');
    if (outcome.kind !== 'SESSION_LOST_DURING_SAVE') return;
    expect(outcome.detail.appliedEntryIndexes).toEqual([4]);
    expect(board.counts.stripWrites).toBe(1);
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('reports a readback mismatch instead of persisting it', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    /* The write lands, and then something else moves the value before the
       readback - the board does not hold what was asked for. */
    const originalRequest = board.request.bind(board);
    let intercepted = false;
    board.request = async (command, payload, options) => {
      const result = await originalRequest(command, payload, options);
      if (command === LED_CMD.SET_VALUES && !intercepted) {
        intercepted = true;
        board.externallySetValues({brightness: 42});
      }
      return result;
    };

    const outcome = await controller.save(session.key, {
      observed,
      runtimeValues: {brightness: 70},
    });

    expect(outcome.kind).toBe('READBACK_MISMATCH');
    if (outcome.kind !== 'READBACK_MISMATCH') return;
    expect(outcome.group).toBe('RUNTIME_VALUES');
    expect(board.counts.eepromWrites).toBe(0);
  });
});

/* ================================================================== *
 * 26-29, 70. API MATRIX
 * ================================================================== */

describe('API matrix', () => {
  it.each([
    ['26. API 1.47', 47, 'API_1_47'],
    ['27. API 1.48', 48, 'API_1_48'],
    ['28. API 1.49', 49, 'API_1_49'],
  ])('%s loads and saves under its own contract identity', async (_label, minor, contract) => {
    const board = makeBoard();
    const session = makeSession(board, minor);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);
    expect(observed.apiContract).toBe(contract);

    const next = target(board, FOUR);
    next[0] = withLedColorIndex(FOUR[0], 13);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});
    expect(outcome.kind).toBe('SAVE_VERIFIED');
    expect(board.counts.stripWrites).toBe(1);
  });

  it('29/45. refuses every write above the newest verified API', async () => {
    const board = makeBoard();
    const session = makeSession(board, 50);
    const controller = makeController(session);

    /* A read is still allowed, against the newest layout actually verified. */
    const observed = await loadOrThrow(controller, session);
    expect(observed.apiContract).toBe('API_1_49');
    expect(writeCounts(board)).toEqual(NO_WRITES);

    const next = target(board, FOUR);
    next[0] = withLedColorIndex(FOUR[0], 13);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next},
      palette: new Map([[1, {hue: 1, whiteness: 2, value: 3}]]),
      runtimeValues: {brightness: 60},
    });

    expect(outcome).toEqual({kind: 'REJECTED', reason: 'UNVERIFIED_FUTURE_API'});
    /* Not one SET, not one EEPROM cycle. */
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });
});

/* ================================================================== *
 * SESSION, PERSISTENCE AND LIFECYCLE
 * ================================================================== */

describe('session ownership and persistence lifecycle', () => {
  it('refuses a draft built on a previous session', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    session.reconnect();

    const next = target(board, FOUR);
    next[0] = withLedColorIndex(FOUR[0], 13);
    const outcome = await controller.save(session.key, {observed, entries: {target: next}});

    expect(outcome).toEqual({kind: 'REFUSED', refusal: {kind: 'STALE_SESSION'}});
    expect(board.counts.stripWrites).toBe(0);
    expect(board.counts.eepromWrites).toBe(0);
  });

  it('writes EXACTLY ONE EEPROM commit for a multi-group save', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const next = target(board, FOUR);
    next[1] = withLedColorIndex(FOUR[1], 10);
    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: next},
      palette: new Map([[2, {hue: 120, whiteness: 0, value: 255}]]),
      modeColors: [{mode: 3, slot: 1, value: 8}],
      runtimeValues: {brightness: 75},
    });

    expect(outcome.kind).toBe('SAVE_VERIFIED');
    /* One per LED, one per group, or one per save - only the last is right. */
    expect(board.counts.eepromWrites).toBe(1);
    expect(board.counts.stripWrites).toBe(1);
    expect(board.counts.paletteWrites).toBe(1);
    expect(board.counts.modeColorWrites).toBe(1);
    expect(board.counts.runtimeValueWrites).toBe(1);
  });

  it('persists only after every group has been read back', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const order: number[] = [];
    const original = board.request.bind(board);
    board.request = async (command, payload, options) => {
      order.push(command);
      return original(command, payload, options);
    };

    const next = target(board, FOUR);
    next[1] = withLedColorIndex(FOUR[1], 10);
    await controller.save(session.key, {
      observed,
      entries: {target: next},
      runtimeValues: {brightness: 75},
    });

    const eepromAt = order.indexOf(LED_CMD.EEPROM);
    expect(eepromAt).toBeGreaterThan(-1);
    const lastEntryWrite = order.lastIndexOf(LED_CMD.SET_STRIP_CONFIG);
    const lastValueWrite = order.lastIndexOf(LED_CMD.SET_VALUES);
    /* A verification read of each written group sits between its write and
       the persist. */
    expect(order.slice(lastEntryWrite, eepromAt)).toContain(LED_CMD.STRIP_CONFIG);
    expect(order.slice(lastValueWrite, eepromAt)).toContain(LED_CMD.GET_VALUES);
  });

  it('never reboots the flight controller', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const next = target(board, FOUR);
    next[0] = withLedColorIndex(FOUR[0], 13);
    await controller.save(session.key, {observed, entries: {target: next}});

    expect(board.counts.reboots).toBe(0);
    expect(board.countOf(LED_CMD.REBOOT)).toBe(0);
  });

  it('spends no EEPROM cycle when the fresh read already matches the draft', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const outcome = await controller.save(session.key, {
      observed,
      entries: {target: target(board, FOUR)},
      runtimeValues: {brightness: 50},
    });

    expect(outcome.kind).toBe('NO_CHANGES');
    expect(writeCounts(board)).toEqual(NO_WRITES);
  });

  it('refuses a second save while one is already running', async () => {
    const board = makeBoard();
    const session = makeSession(board);
    const controller = makeController(session);
    const observed = await loadOrThrow(controller, session);

    const next = target(board, FOUR);
    next[0] = withLedColorIndex(FOUR[0], 13);
    const request: LedStripSaveRequest = {observed, entries: {target: next}};

    const [first, second] = await Promise.all([
      controller.save(session.key, request),
      controller.save(session.key, request),
    ]);
    const kinds = [first.kind, second.kind];
    expect(kinds).toContain('REJECTED');
    /* Whichever won, the writes were never interleaved. */
    expect(board.counts.eepromWrites).toBeLessThanOrEqual(1);
  });
});
