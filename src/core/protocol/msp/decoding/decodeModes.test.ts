import {decodeModesConfiguration, MODE_RANGE_MAX, MODE_RANGE_MIN} from './decodeModes';

const names = Uint8Array.from([...Buffer.from('ARM;ANGLE;BEEPER;', 'ascii')]);
const boxIds = Uint8Array.from([0, 1, 13]);

function fixture(): {ranges: Uint8Array; rangesExtra: Uint8Array} {
  const ranges = new Uint8Array(20 * 4);
  const rangesExtra = new Uint8Array(1 + 20 * 3);
  rangesExtra[0] = 20;
  for (let index = 0; index < 20; index += 1) {
    ranges[index * 4] = 0;
    rangesExtra[1 + index * 3] = 0;
  }
  ranges.set([1, 2, 12, 28], 0);
  rangesExtra.set([1, 1, 0], 1);
  ranges.set([13, 0, 0, 0], 4);
  rangesExtra.set([13, 0, 1], 4);
  return {ranges, rangesExtra};
}

describe('decodeModesConfiguration', () => {
  it('joins names, permanent IDs, ranges, logic and links without losing empty slots', () => {
    const decoded = decodeModesConfiguration({names, boxIds, ...fixture()});
    expect(decoded.capacity).toBe(20);
    expect(decoded.definitions).toEqual([
      {name: 'ARM', permanentId: 0, flagIndex: 0},
      {name: 'ANGLE', permanentId: 1, flagIndex: 1},
      {name: 'BEEPER', permanentId: 13, flagIndex: 2},
    ]);
    expect(decoded.slots[0]).toEqual({permanentId: 1, auxChannelIndex: 2, start: 1200, end: 1600, logic: 1, linkedTo: 0});
    expect(decoded.slots[1]).toEqual({permanentId: 13, auxChannelIndex: 0, start: MODE_RANGE_MIN, end: MODE_RANGE_MIN, logic: 0, linkedTo: 1});
    expect(decoded.slots).toHaveLength(20);
  });

  it('rejects malformed or contradictory tables', () => {
    const base = fixture();
    expect(() => decodeModesConfiguration({names, boxIds: Uint8Array.from([0, 1]), ...base})).toThrow(/count/);
    expect(() => decodeModesConfiguration({names, boxIds, ranges: base.ranges.slice(1), rangesExtra: base.rangesExtra})).toThrow(/four-byte/);
    expect(() => decodeModesConfiguration({names, boxIds, ranges: base.ranges, rangesExtra: base.rangesExtra.slice(0, -1)})).toThrow(/align/);
    const mismatch = {...base, rangesExtra: base.rangesExtra.slice()}; mismatch.rangesExtra[1] = 13;
    expect(() => decodeModesConfiguration({names, boxIds, ...mismatch})).toThrow(/mismatched/);
    const badLogic = {...base, rangesExtra: base.rangesExtra.slice()}; badLogic.rangesExtra[2] = 2;
    expect(() => decodeModesConfiguration({names, boxIds, ...badLogic})).toThrow(/logic/);
    const badRange = {...base, ranges: base.ranges.slice()}; badRange.ranges[3] = (MODE_RANGE_MAX - MODE_RANGE_MIN) / 25 + 1;
    expect(() => decodeModesConfiguration({names, boxIds, ...badRange})).toThrow(/outside/);
  });
});
