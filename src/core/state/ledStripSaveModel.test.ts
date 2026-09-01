/* eslint-disable no-bitwise -- test words are composed by hand from the
 * firmware field offsets. */
import {
  ledEntryArrayIsCanonical,
  mergeLedPalette,
  mergeLedRuntimeValues,
  planLedEntryWrites,
  planLedModeColorWrites,
  LED_SAVE_GROUP_ORDER,
  type LedPaletteEntry,
} from './ledStripSaveModel';
import {decodeLedEntry, type LedEntry} from '../protocol/msp/decoding/ledStripWireContract';

/** Words composed by hand; x and y differ so none can equal the terminator. */
const w = (n: number): number => ((n & 0x0f) | (((n + 1) & 0x0f) << 4) | (1 << 8)) >>> 0;
const entries = (words: readonly number[]): LedEntry[] =>
  words.map((word, index) => decodeLedEntry(word, index));

describe('save group order is deterministic', () => {
  it('is entries, palette, mode colours, runtime values', () => {
    expect([...LED_SAVE_GROUP_ORDER]).toEqual([
      'ENTRIES',
      'PALETTE',
      'MODE_COLORS',
      'RUNTIME_VALUES',
    ]);
  });
});

describe('entry planner - same count', () => {
  const observed = [w(1), w(2), w(3), w(4), 0, 0, 0, 0];

  it('writes only the entry that changed', () => {
    const target = [...observed];
    target[2] = w(9);
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target});
    expect(plan.kind).toBe('PLANNED');
    if (plan.kind !== 'PLANNED') return;
    expect(plan.writes).toEqual([{index: 2, raw: w(9), phase: 'RETAINED'}]);
    expect(plan.writes).toHaveLength(1);
  });

  it('writes nothing at all when nothing changed', () => {
    const plan = planLedEntryWrites({
      fresh: entries(observed),
      baseline: observed,
      target: [...observed],
    });
    expect(plan.kind).toBe('PLANNED');
    if (plan.kind !== 'PLANNED') return;
    expect(plan.writes).toHaveLength(0);
  });

  it('never rewrites the zero tail', () => {
    const target = [...observed];
    target[0] = w(7);
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes.map(write => write.index)).toEqual([0]);
  });
});

describe('entry planner - extension', () => {
  const observed = [w(1), w(2), w(3), w(4), 0, 0];
  const target = [w(1), w(2), w(3), w(4), w(5), w(6)];

  it('extends ascending from the old terminator', () => {
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes).toEqual([
      {index: 4, raw: w(5), phase: 'EXTEND'},
      {index: 5, raw: w(6), phase: 'EXTEND'},
    ]);
  });

  it('never places a new LED beyond a slot that is still zero', () => {
    /* The whole point: writing index 5 first would leave index 4 zero and
       the firmware would stop counting there, so the new LED would exist
       in memory and be invisible on the aircraft. */
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    const extendIndexes = plan.writes.filter(x => x.phase === 'EXTEND').map(x => x.index);
    expect(extendIndexes).toEqual([...extendIndexes].sort((a, b) => a - b));
    expect(extendIndexes[0]).toBe(4);
  });

  it('writes changed retained entries before extending', () => {
    const changed = [...target];
    changed[1] = w(11);
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target: changed});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes.map(x => [x.index, x.phase])).toEqual([
      [1, 'RETAINED'],
      [4, 'EXTEND'],
      [5, 'EXTEND'],
    ]);
  });
});

describe('entry planner - shrink', () => {
  const observed = [w(1), w(2), w(3), w(4), w(5), w(6), 0, 0];
  const target = [w(1), w(2), w(3), w(4), 0, 0, 0, 0];

  it('commits the new terminator before clearing the old tail', () => {
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes).toEqual([
      {index: 4, raw: 0, phase: 'TERMINATE'},
      {index: 5, raw: 0, phase: 'CLEANUP'},
    ]);
  });

  it('does not zero a higher tail index first', () => {
    /* Clearing index 5 first would walk the strip down through a count of
       five that nobody asked for. */
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes[0]).toEqual({index: 4, raw: 0, phase: 'TERMINATE'});
    const terminateAt = plan.writes.findIndex(x => x.phase === 'TERMINATE');
    const firstCleanup = plan.writes.findIndex(x => x.phase === 'CLEANUP');
    expect(terminateAt).toBeLessThan(firstCleanup);
  });

  it('writes changed retained entries before the terminator', () => {
    const changed = [...target];
    changed[0] = w(12);
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target: changed});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes.map(x => x.phase)).toEqual(['RETAINED', 'TERMINATE', 'CLEANUP']);
  });

  it('clears the whole strip with a terminator at index zero', () => {
    const empty = observed.map(() => 0);
    const plan = planLedEntryWrites({fresh: entries(observed), baseline: observed, target: empty});
    if (plan.kind !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.writes[0]).toEqual({index: 0, raw: 0, phase: 'TERMINATE'});
    expect(plan.writes.slice(1).every(x => x.phase === 'CLEANUP')).toBe(true);
    expect(plan.targetEffectiveCount).toBe(0);
  });
});

describe('entry planner - refusals', () => {
  const observed = [w(1), w(2), 0, 0];

  it('refuses a target array of the wrong length', () => {
    const plan = planLedEntryWrites({
      fresh: entries(observed),
      baseline: observed,
      target: [w(1), w(2)],
    });
    expect(plan).toEqual({
      kind: 'REFUSED',
      refusal: {kind: 'TARGET_LENGTH_MISMATCH', expected: 4, actual: 2},
    });
  });

  it('refuses a target word that is not a u32', () => {
    const plan = planLedEntryWrites({
      fresh: entries(observed),
      baseline: observed,
      target: [w(1), -1, 0, 0],
    });
    expect(plan).toEqual({kind: 'REFUSED', refusal: {kind: 'TARGET_WORD_INVALID', index: 1}});
  });

  it('refuses a target with a configured entry past its own terminator', () => {
    const plan = planLedEntryWrites({
      fresh: entries(observed),
      baseline: observed,
      target: [w(1), 0, w(3), 0],
    });
    expect(plan.kind).toBe('REFUSED');
    if (plan.kind !== 'REFUSED') return;
    expect(plan.refusal.kind).toBe('TARGET_HAS_GAP');
  });

  it('refuses when the caller declared a count its own array does not yield', () => {
    /* An LED the caller believes exists whose word came out all-zeros: the
       array silently describes fewer LEDs than they asked for. */
    const plan = planLedEntryWrites({
      fresh: entries(observed),
      baseline: observed,
      target: [w(1), 0, 0, 0],
      declaredEffectiveCount: 2,
    });
    expect(plan).toEqual({
      kind: 'REFUSED',
      refusal: {kind: 'TARGET_EFFECTIVE_COUNT_MISMATCH', declared: 2, derived: 1},
    });
  });

  it('refuses to write over a board that already has a gap', () => {
    const holed = [w(1), 0, w(3), 0];
    const plan = planLedEntryWrites({
      fresh: entries(holed),
      baseline: holed,
      target: [w(1), w(2), w(3), 0],
    });
    expect(plan.kind).toBe('REFUSED');
    if (plan.kind !== 'REFUSED') return;
    expect(plan.refusal).toEqual({
      kind: 'OBSERVED_STRIP_HAS_GAP',
      terminatorIndex: 1,
      unreachable: [2],
    });
  });

  it('refuses when any entry moved since the baseline was read', () => {
    const moved = [w(1), w(2), w(3), 0];
    const plan = planLedEntryWrites({
      fresh: entries(moved),
      baseline: observed,
      target: [w(9), w(2), 0, 0],
    });
    expect(plan).toEqual({
      kind: 'REFUSED',
      refusal: {kind: 'STALE_ENTRIES_STATE', firstDivergentIndex: 2},
    });
  });

  it('does not refuse when the board is already at the requested target', () => {
    const moved = [w(1), w(2), w(3), 0];
    const plan = planLedEntryWrites({
      fresh: entries(moved),
      baseline: observed,
      target: [...moved],
    });
    expect(plan.kind).toBe('PLANNED');
    if (plan.kind !== 'PLANNED') return;
    expect(plan.writes).toHaveLength(0);
  });
});

describe('canonical array check', () => {
  it('accepts a clean prefix with a zero tail', () => {
    expect(ledEntryArrayIsCanonical([w(1), w(2), 0, 0])).toBe(true);
    expect(ledEntryArrayIsCanonical([0, 0, 0])).toBe(true);
    expect(ledEntryArrayIsCanonical([w(1)])).toBe(true);
  });

  it('rejects a configured word past a terminator', () => {
    expect(ledEntryArrayIsCanonical([w(1), 0, w(3)])).toBe(false);
  });
});

describe('palette merge', () => {
  const color = (n: number): LedPaletteEntry => ({hue: n, whiteness: n + 1, value: n + 2});
  const baseline = Array.from({length: 16}, (_unused, i) => color(i));

  it('keeps the fresh board value for every slot nobody owns', () => {
    const fresh = [...baseline];
    fresh[8] = color(200);
    const merged = mergeLedPalette({
      fresh,
      baseline,
      owned: new Map([[3, color(50)]]),
    });
    expect(merged.kind).toBe('MERGED');
    if (merged.kind !== 'MERGED') return;
    expect(merged.colors[3]).toEqual(color(50));
    /* The external change to slot 8 survives - taking it from the stale
       baseline would silently revert somebody else's edit. */
    expect(merged.colors[8]).toEqual(color(200));
    expect(merged.changed).toBe(true);
  });

  it('refuses when an owned slot moved to something else', () => {
    const fresh = [...baseline];
    fresh[3] = color(99);
    const merged = mergeLedPalette({fresh, baseline, owned: new Map([[3, color(50)]])});
    expect(merged).toEqual({kind: 'STALE_PALETTE_SLOT', slot: 3});
  });

  it('accepts an owned slot that already moved to the requested value', () => {
    const fresh = [...baseline];
    fresh[3] = color(50);
    const merged = mergeLedPalette({fresh, baseline, owned: new Map([[3, color(50)]])});
    expect(merged.kind).toBe('MERGED');
    if (merged.kind !== 'MERGED') return;
    expect(merged.changed).toBe(false);
  });

  it('reports no change when the owned slot is already what it was', () => {
    const merged = mergeLedPalette({
      fresh: baseline,
      baseline,
      owned: new Map([[5, color(5)]]),
    });
    expect(merged.kind).toBe('MERGED');
    if (merged.kind !== 'MERGED') return;
    expect(merged.changed).toBe(false);
  });
});

describe('mode-colour planning', () => {
  const baseline = [
    {mode: 0, slot: 0, value: 1},
    {mode: 0, slot: 1, value: 2},
    {mode: 6, slot: 9, value: 3},
    {mode: 7, slot: 0, value: 4},
  ];

  it('writes only the tuples that changed', () => {
    const plan = planLedModeColorWrites({
      fresh: baseline,
      baseline,
      owned: [
        {mode: 0, slot: 0, value: 7},
        {mode: 0, slot: 1, value: 2},
      ],
    });
    expect(plan).toEqual({kind: 'PLANNED', writes: [{mode: 0, slot: 0, value: 7}]});
  });

  it('refuses when an owned tuple moved underneath the operator', () => {
    const fresh = baseline.map(t => (t.mode === 0 && t.slot === 0 ? {...t, value: 12} : t));
    const plan = planLedModeColorWrites({
      fresh,
      baseline,
      owned: [{mode: 0, slot: 0, value: 7}],
    });
    expect(plan).toEqual({kind: 'STALE_MODE_COLOR', mode: 0, slot: 0});
  });

  it('accepts an owned tuple that already holds the requested value', () => {
    const fresh = baseline.map(t => (t.mode === 0 && t.slot === 0 ? {...t, value: 7} : t));
    const plan = planLedModeColorWrites({
      fresh,
      baseline,
      owned: [{mode: 0, slot: 0, value: 7}],
    });
    expect(plan).toEqual({kind: 'PLANNED', writes: []});
  });

  it('never plans a write for a tuple nobody owns', () => {
    /* Which is exactly how the three unnamed special slots and the
       runtime-inert mode are preserved: by not being sent. */
    const plan = planLedModeColorWrites({
      fresh: baseline,
      baseline,
      owned: [{mode: 7, slot: 0, value: 9}],
    });
    expect(plan).toEqual({kind: 'PLANNED', writes: [{mode: 7, slot: 0, value: 9}]});
  });

  it('reports a tuple the board never sent', () => {
    const plan = planLedModeColorWrites({
      fresh: baseline,
      baseline,
      owned: [{mode: 3, slot: 3, value: 1}],
    });
    expect(plan).toEqual({kind: 'TUPLE_ABSENT', mode: 3, slot: 3});
  });
});

describe('runtime value merge', () => {
  const baseline = {brightness: 50, rainbowDelta: 10, rainbowFreq: 120};

  it('patches the edited field onto the fresh board tuple', () => {
    const fresh = {brightness: 50, rainbowDelta: 10, rainbowFreq: 999};
    const merged = mergeLedRuntimeValues({fresh, baseline, owned: {brightness: 80}});
    expect(merged.kind).toBe('MERGED');
    if (merged.kind !== 'MERGED') return;
    expect(merged.values).toEqual({brightness: 80, rainbowDelta: 10, rainbowFreq: 999});
    expect(merged.changed).toBe(true);
  });

  it('refuses when an edited field moved to something else', () => {
    const fresh = {...baseline, brightness: 61};
    const merged = mergeLedRuntimeValues({fresh, baseline, owned: {brightness: 80}});
    expect(merged).toEqual({kind: 'STALE_RUNTIME_VALUE', field: 'brightness'});
  });

  it('accepts an edited field already at the requested value', () => {
    const fresh = {...baseline, brightness: 80};
    const merged = mergeLedRuntimeValues({fresh, baseline, owned: {brightness: 80}});
    expect(merged.kind).toBe('MERGED');
    if (merged.kind !== 'MERGED') return;
    expect(merged.changed).toBe(false);
  });

  it('preserves a genuine zero the board reports', () => {
    const fresh = {brightness: 0, rainbowDelta: 0, rainbowFreq: 0};
    const merged = mergeLedRuntimeValues({
      fresh,
      baseline: fresh,
      owned: {rainbowDelta: 5},
    });
    expect(merged.kind).toBe('MERGED');
    if (merged.kind !== 'MERGED') return;
    expect(merged.values).toEqual({brightness: 0, rainbowDelta: 5, rainbowFreq: 0});
  });
});
