/**
 * THE MODES TABLE IS READ, NOT AUDITED.
 *
 * This suite used to pin thirteen rejection points, and this is the ARM
 * screen: any one of them meant the operator could not see or fix ANY
 * mode, including a perfectly good arm switch.
 *
 * The pinned Betaflight Configurator validates none of it
 * (src/js/msp/MSPHelper.js, cases MSP_MODE_RANGES and
 * MSP_MODE_RANGES_EXTRA): the range count is `data.byteLength / 4`, the
 * extra count is its own leading byte, and every field is stored exactly
 * as read. Betaflight adds flight modes regularly, so a firmware carrying
 * a mode this build has never seen must still open - it now does, with
 * the unknown id reported rather than fatal.
 */

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
    expect(decoded.slots[0]).toEqual({
      permanentId: 1, auxChannelIndex: 2, start: 1200, end: 1600,
      logic: 1, linkedTo: 0, outOfRange: false,
    });
    expect(decoded.slots[1]).toEqual({
      permanentId: 13, auxChannelIndex: 0, start: MODE_RANGE_MIN, end: MODE_RANGE_MIN,
      logic: 0, linkedTo: 1, outOfRange: false,
    });
    expect(decoded.slots).toHaveLength(20);
    expect(decoded.unknownIds).toEqual([]);
  });

  it('A MODE THIS BUILD HAS NEVER HEARD OF still loads, and is reported', () => {
    // The whole point: Betaflight adds modes, and an unknown one used to
    // take the entire ARM screen down with it.
    const base = fixture();
    const ranges = base.ranges.slice();
    const rangesExtra = base.rangesExtra.slice();
    ranges.set([99, 3, 12, 28], 8); // permanentId 99 is not in boxIds
    rangesExtra.set([99, 0, 0], 1 + 2 * 3);

    const decoded = decodeModesConfiguration({names, boxIds, ranges, rangesExtra});
    expect(decoded.unknownIds).toEqual([99]);
    // ...and every KNOWN mode is still fully readable.
    expect(decoded.slots[0].permanentId).toBe(1);
    expect(decoded.definitions).toHaveLength(3);
  });

  it('a BOXIDS/BOXNAMES count mismatch yields a partial catalogue, not a dead screen', () => {
    const decoded = decodeModesConfiguration({
      names, boxIds: Uint8Array.from([0, 1]), ...fixture(),
    });
    expect(decoded.definitions.map(definition => definition.name)).toEqual(['ARM', 'ANGLE']);
    expect(decoded.slots).toHaveLength(20);
  });

  it('a trailing partial range record is ignored, as Betaflight integer-divides it away', () => {
    const base = fixture();
    const decoded = decodeModesConfiguration({
      names, boxIds, ranges: base.ranges.slice(0, -2), rangesExtra: base.rangesExtra,
    });
    expect(decoded.capacity).toBe(19);
  });

  it('a short MODE_RANGES_EXTRA leaves those slots at their defaults', () => {
    const base = fixture();
    const decoded = decodeModesConfiguration({
      names, boxIds, ranges: base.ranges, rangesExtra: base.rangesExtra.slice(0, 7),
    });
    expect(decoded.slots[0].logic).toBe(1);
    // Beyond what EXTRA actually carried: defaults, never an exception.
    expect(decoded.slots[10].logic).toBe(0);
    expect(decoded.slots[10].linkedTo).toBe(0);
  });

  it('an absent MODE_RANGES_EXTRA is survivable', () => {
    const base = fixture();
    const decoded = decodeModesConfiguration({
      names, boxIds, ranges: base.ranges, rangesExtra: new Uint8Array(0),
    });
    expect(decoded.slots).toHaveLength(20);
    expect(decoded.slots.every(slot => slot.logic === 0 && slot.linkedTo === 0)).toBe(true);
  });

  it('a stray logic byte clamps to OR rather than throwing', () => {
    // OR (0) is the clamp because it cannot silently ADD a condition to an
    // arm switch the way AND could.
    const base = fixture();
    const rangesExtra = base.rangesExtra.slice();
    rangesExtra[2] = 2;
    const decoded = decodeModesConfiguration({names, boxIds, ranges: base.ranges, rangesExtra});
    expect(decoded.slots[0].logic).toBe(0);
  });

  it('an out-of-range stored range is SHOWN and flagged, not hidden', () => {
    const base = fixture();
    const ranges = base.ranges.slice();
    ranges[3] = (MODE_RANGE_MAX - MODE_RANGE_MIN) / 25 + 1;
    const decoded = decodeModesConfiguration({names, boxIds, ranges, rangesExtra: base.rangesExtra});
    expect(decoded.slots[0].outOfRange).toBe(true);
    expect(decoded.slots[0].end).toBeGreaterThan(MODE_RANGE_MAX);
  });

  it('a non-printable byte in MSP_BOXNAMES is dropped, not fatal', () => {
    const noisy = Uint8Array.from([...Buffer.from('ARM;AN', 'ascii'), 0x01, ...Buffer.from('GLE;BEEPER;', 'ascii')]);
    const decoded = decodeModesConfiguration({names: noisy, boxIds, ...fixture()});
    expect(decoded.definitions.map(definition => definition.name)).toEqual(['ARM', 'ANGLE', 'BEEPER']);
  });
});
