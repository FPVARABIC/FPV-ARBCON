/**
 * THE RPM FILTER'S TWO SHAPES, AND THE LINE BETWEEN THEM.
 *
 * =====================================================================
 * THE FIXTURE IS HAND-WRITTEN, AND HAS TO BE
 * =====================================================================
 *
 * Every payload in this file is assembled byte by byte from the firmware's
 * own serializer order, NEVER from `patchRpmFilterDraft`. Generating the
 * expected bytes with the encoder under test would prove only that the
 * encoder agrees with itself: an offset that is wrong in both directions
 * round-trips perfectly and the test stays green while every real board
 * gets the wrong byte.
 *
 * The offsets come from `MSP_FILTER_CONFIG` in msp.c at the pinned 1.49
 * tree, counted through its `sbufWriteU8`/`sbufWriteU16` calls:
 *
 *   43  rpm_filter_harmonics      u8
 *   44  rpm_filter_min_hz         u8
 *   45  dyn_notch_max_hz          u16   <- NOT ours, and must not move
 *   47  dterm_lpf1_dyn_expo       u8
 *   48  dyn_notch_count           u8    <- NOT ours, and must not move
 *   -- API 1.48 tail --
 *   49  rpm_filter_fade_range_hz  u16
 *   51  rpm_filter_q              u16
 *   53  rpm_filter_weights[0..2]  u8 u8 u8
 */

import {
  MSP_FILTER_CONFIG_BYTES_API147,
  MSP_FILTER_CONFIG_BYTES_API148,
  type PidApiContract,
} from '../protocol/msp/decoding/pidWireContracts';
import {
  RPM_FILTER_BOUNDS,
  RPM_FILTER_HEAD_KEYS,
  RPM_FILTER_TAIL_KEYS,
  createRpmFilterDraftFromRaw,
  invalidRpmFilterFields,
  movedRpmFilterFields,
  patchRpmFilterDraft,
  rpmFilterBoundFor,
  rpmFilterDraftsEqual,
  rpmFilterValue,
  rpmTailInContract,
  withRpmFilterValue,
  type RpmFilterDraft,
} from './rpmFilterFields';

/**
 * A 56-byte MSP_FILTER_CONFIG, written here as literal bytes.
 *
 * The values are deliberately all different from each other and from the
 * firmware defaults, so that a decoder reading the wrong offset produces a
 * visibly wrong number rather than a plausible one.
 *
 *   harmonics 2, min 120 Hz, fade 640 Hz, q 1250, weights 90 / 55 / 10
 *   dyn_notch_max_hz 600 and dyn_notch_count 4 sit BETWEEN the two halves
 *   and are here so a tail that drifted would collide with them.
 */
const API148_PAYLOAD: readonly number[] = [
  /* 0..42 - everything before the RPM head. Filled with a recognisable
     ramp so a stray write anywhere in it is visible. */
  ...Array.from({length: 43}, (_unused, index) => (index * 3 + 1) % 256),
  2,            // 43 rpm_filter_harmonics
  120,          // 44 rpm_filter_min_hz
  0x58, 0x02,   // 45 dyn_notch_max_hz  = 600
  7,            // 47 dterm_lpf1_dyn_expo
  4,            // 48 dyn_notch_count
  0x80, 0x02,   // 49 rpm_filter_fade_range_hz = 640
  0xE2, 0x04,   // 51 rpm_filter_q = 1250
  90, 55, 10,   // 53,54,55 rpm_filter_weights
];

function api148(): Uint8Array {
  const bytes = Uint8Array.from(API148_PAYLOAD);
  if (bytes.length !== MSP_FILTER_CONFIG_BYTES_API148) {
    throw new Error(`hand-written fixture is ${bytes.length} bytes, not 56`);
  }
  return bytes;
}

/** The same board one API version earlier: the tail simply is not sent. */
function api147(): Uint8Array {
  const bytes = api148().slice(0, MSP_FILTER_CONFIG_BYTES_API147);
  if (bytes.length !== 49) throw new Error('1.47 fixture must be 49 bytes');
  return bytes;
}

describe('which contracts define the RPM tail', () => {
  it('answers from the contract and nothing else', () => {
    expect(rpmTailInContract('API_1_47')).toBe(false);
    expect(rpmTailInContract('API_1_48')).toBe(true);
    expect(rpmTailInContract('API_1_49')).toBe(true);
  });
});

describe('decoding the RPM filter from a hand-written payload', () => {
  it('reads all seven fields at their firmware offsets under API 1.48', () => {
    expect(createRpmFilterDraftFromRaw(api148(), 'API_1_48')).toEqual({
      harmonics: 2,
      minHz: 120,
      tail: {fadeRangeHz: 640, q: 1250, weights: [90, 55, 10]},
    });
  });

  it('reads the same seven under API 1.49, which shares the layout', () => {
    expect(createRpmFilterDraftFromRaw(api148(), 'API_1_49'))
      .toEqual(createRpmFilterDraftFromRaw(api148(), 'API_1_48'));
  });

  it('reports the tail ABSENT under API 1.47, not zero', () => {
    const draft = createRpmFilterDraftFromRaw(api147(), 'API_1_47');
    expect(draft.harmonics).toBe(2);
    expect(draft.minHz).toBe(120);
    expect(draft.tail).toBeUndefined();
    // The distinction the whole module exists for: `undefined` and 0 are
    // different answers and must never compare equal.
    for (const field of RPM_FILTER_TAIL_KEYS) {
      expect(rpmFilterValue(draft, field)).toBeUndefined();
      expect(rpmFilterValue(draft, field)).not.toBe(0);
    }
  });

  it('refuses to invent a tail from a 56-byte payload on a 1.47 contract', () => {
    // The bytes are THERE, and are still not read: presence is decided by
    // the proven API version, never by what happens to be in the buffer.
    expect(createRpmFilterDraftFromRaw(api148(), 'API_1_47').tail).toBeUndefined();
  });
});

describe('patching the RPM filter back into the board\'s own payload', () => {
  it('writes all seven fields at their firmware offsets under API 1.48', () => {
    const payload = api148();
    patchRpmFilterDraft(payload, {
      harmonics: 3,
      minHz: 45,
      tail: {fadeRangeHz: 1000, q: 3000, weights: [100, 0, 33]},
    }, 'API_1_48');
    const view = new DataView(payload.buffer);
    expect(payload[43]).toBe(3);
    expect(payload[44]).toBe(45);
    expect(view.getUint16(49, true)).toBe(1000);
    expect(view.getUint16(51, true)).toBe(3000);
    expect([payload[53], payload[54], payload[55]]).toEqual([100, 0, 33]);
  });

  it('leaves dyn_notch_max_hz and dyn_notch_count exactly where they were', () => {
    // These two are the immediate neighbours of the RPM group and belong to
    // a different parameter group entirely. A one-byte drift in the tail
    // lands on them, so they are the tripwire.
    const payload = api148();
    patchRpmFilterDraft(payload, {
      harmonics: 3, minHz: 45,
      tail: {fadeRangeHz: 1000, q: 3000, weights: [100, 0, 33]},
    }, 'API_1_49');
    expect(new DataView(payload.buffer).getUint16(45, true)).toBe(600);
    expect(payload[47]).toBe(7);
    expect(payload[48]).toBe(4);
  });

  it('never touches bytes 49-55 under API 1.47 even when handed a tail', () => {
    /* THE CONTRACT IS THE GUARD, not the draft's shape.
       A draft carrying a tail should be impossible on a 1.47 board - the
       decoder does not build one and `withRpmFilterValue` refuses to create
       one - but "impossible" is a claim about today's callers. If the only
       thing stopping bytes 49-55 from being written were `draft.tail ===
       undefined`, then one future caller constructing a draft by hand would
       send a 1.47 board seven bytes it never asked for. */
    const payload = api148();
    const before = payload.slice();
    patchRpmFilterDraft(payload, {
      harmonics: 1, minHz: 60,
      tail: {fadeRangeHz: 999, q: 2999, weights: [11, 22, 33]},
    }, 'API_1_47');
    expect(payload[43]).toBe(1);
    expect(payload[44]).toBe(60);
    expect([...payload.subarray(45)]).toEqual([...before.subarray(45)]);
  });

  it('never touches bytes 49-55 under API 1.47', () => {
    /* The 1.47 payload is 49 bytes long, so those offsets do not exist.
       Patching a LONGER buffer under a 1.47 contract proves the guard is
       the contract and not the buffer's length: the tail bytes must come
       back byte-for-byte unchanged. */
    const payload = api148();
    const before = payload.slice();
    patchRpmFilterDraft(payload, {harmonics: 3, minHz: 45, tail: undefined}, 'API_1_47');
    expect(payload[43]).toBe(3);
    expect(payload[44]).toBe(45);
    expect([...payload.subarray(45)]).toEqual([...before.subarray(45)]);
  });

  it('preserves every byte the RPM group does not own', () => {
    const payload = api148();
    const before = payload.slice();
    patchRpmFilterDraft(payload, createRpmFilterDraftFromRaw(payload, 'API_1_49'), 'API_1_49');
    // An unchanged draft written back must reproduce the payload exactly.
    expect([...payload]).toEqual([...before]);
  });
});

describe('editing a draft', () => {
  const withTail = (): RpmFilterDraft =>
    createRpmFilterDraftFromRaw(api148(), 'API_1_49');
  const headOnly = (): RpmFilterDraft =>
    createRpmFilterDraftFromRaw(api147(), 'API_1_47');

  it('moves the field asked for and nothing else', () => {
    const next = withRpmFilterValue(withTail(), 'weight2', 77);
    expect(rpmFilterValue(next, 'weight2')).toBe(77);
    expect(rpmFilterValue(next, 'weight1')).toBe(90);
    expect(rpmFilterValue(next, 'weight3')).toBe(10);
    expect(rpmFilterValue(next, 'q')).toBe(1250);
  });

  it('DROPS a tail edit on a contract with no tail rather than creating one', () => {
    for (const field of RPM_FILTER_TAIL_KEYS) {
      expect(withRpmFilterValue(headOnly(), field, 500).tail).toBeUndefined();
    }
    // The head still edits normally on the same draft.
    expect(withRpmFilterValue(headOnly(), 'harmonics', 1).harmonics).toBe(1);
  });

  it('reports which fields moved, across both halves', () => {
    const stored = withTail();
    const draft = withRpmFilterValue(withRpmFilterValue(stored, 'minHz', 60), 'q', 900);
    expect([...movedRpmFilterFields(stored, draft)].sort()).toEqual(['minHz', 'q']);
    expect(movedRpmFilterFields(stored, stored)).toEqual([]);
  });

  it('compares two drafts including the presence of the tail itself', () => {
    expect(rpmFilterDraftsEqual(withTail(), withTail())).toBe(true);
    expect(rpmFilterDraftsEqual(headOnly(), headOnly())).toBe(true);
    // Same head values, different contracts: NOT equal, because one of them
    // carries five fields the other does not have at all.
    expect(rpmFilterDraftsEqual(withTail(), headOnly())).toBe(false);
  });
});

describe('the bounds, and where each one comes from', () => {
  it('matches settings.c at the pinned tree, field by field', () => {
    expect(rpmFilterBoundFor('harmonics')).toMatchObject({min: 0, max: 3});
    expect(rpmFilterBoundFor('minHz')).toMatchObject({min: 30, max: 200});
    expect(rpmFilterBoundFor('fadeRangeHz')).toMatchObject({min: 0, max: 1000});
    expect(rpmFilterBoundFor('q')).toMatchObject({min: 250, max: 3000});
    for (const weight of ['weight1', 'weight2', 'weight3'] as const) {
      expect(rpmFilterBoundFor(weight)).toMatchObject({min: 0, max: 100});
    }
  });

  it('cites a source for every bound, so none of them is a guess', () => {
    for (const bound of Object.values(RPM_FILTER_BOUNDS)) {
      expect(bound.source.length).toBeGreaterThan(20);
    }
    // The weights row is MODE_ARRAY and carries no minmax, so its bound is
    // proven from the two places that DO state it.
    expect(RPM_FILTER_BOUNDS.weight.source).toContain('rpm_filter.h');
    expect(RPM_FILTER_BOUNDS.weight.source).toContain('MSP_RESULT_ERROR');
  });

  it('refuses exactly the values MSP_SET_FILTER_CONFIG refuses', () => {
    const stored = createRpmFilterDraftFromRaw(api148(), 'API_1_49');
    const bad: Array<[Parameters<typeof withRpmFilterValue>[1], number]> = [
      ['q', 249], ['q', 3001], ['fadeRangeHz', 1001],
      ['weight1', 101], ['weight2', 101], ['weight3', 101],
    ];
    for (const [field, value] of bad) {
      const draft = withRpmFilterValue(stored, field, value);
      expect(invalidRpmFilterFields(draft, stored)).toContain(field);
    }
    // And accepts the exact edges the firmware accepts.
    for (const [field, value] of [['q', 250], ['q', 3000], ['fadeRangeHz', 1000], ['weight1', 100]] as const) {
      expect(invalidRpmFilterFields(withRpmFilterValue(stored, field, value), stored)).toEqual([]);
    }
  });

  it('is change-scoped, so a stored value out of range does not lock the page', () => {
    /* A board with the RPM filter switched off can report min_hz below the
       firmware's own floor of 30. Holding an untouched field to that bound
       would make the whole screen unsaveable over a byte nobody edited. */
    const payload = api148();
    payload[44] = 0;
    const stored = createRpmFilterDraftFromRaw(payload, 'API_1_49');
    expect(invalidRpmFilterFields(stored, stored)).toEqual([]);
    // Touch it, and it is judged.
    expect(invalidRpmFilterFields(withRpmFilterValue(stored, 'minHz', 10), stored)).toEqual(['minHz']);
  });

  it('never judges a field the contract does not carry', () => {
    const stored = createRpmFilterDraftFromRaw(api147(), 'API_1_47');
    expect(invalidRpmFilterFields(stored)).toEqual([]);
    expect(invalidRpmFilterFields(stored, stored)).toEqual([]);
  });
});

describe('the field lists', () => {
  it('names two head fields and five tail fields, and nothing else', () => {
    expect([...RPM_FILTER_HEAD_KEYS]).toEqual(['harmonics', 'minHz']);
    expect([...RPM_FILTER_TAIL_KEYS]).toEqual([
      'fadeRangeHz', 'q', 'weight1', 'weight2', 'weight3',
    ]);
  });

  it('agrees with the payload length each contract actually carries', () => {
    const lengths: Record<PidApiContract, number> = {
      API_1_47: MSP_FILTER_CONFIG_BYTES_API147,
      API_1_48: MSP_FILTER_CONFIG_BYTES_API148,
      API_1_49: MSP_FILTER_CONFIG_BYTES_API148,
    };
    for (const [contract, length] of Object.entries(lengths) as Array<[PidApiContract, number]>) {
      expect(rpmTailInContract(contract)).toBe(length === MSP_FILTER_CONFIG_BYTES_API148);
    }
  });
});
