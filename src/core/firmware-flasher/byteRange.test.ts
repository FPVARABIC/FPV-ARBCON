import {
  ADDRESS_SPACE_END_EXCLUSIVE,
  containsAddress,
  lastAddress,
  makeRange,
  rangeContainsRange,
  rangeLength,
  rangesOverlap,
} from './byteRange';

/**
 * THE BOUNDARY THAT MATTERS is `endExclusive <= 0x1_0000_0000`, not
 * `start + length <= 0xFFFFFFFF`. The stricter form is off by one and would
 * refuse a one-byte range at the top of the space - a range the Intel-HEX
 * parser upstream already accepts, because it range-checks the LAST address.
 * Two layers disagreeing about the same bytes is exactly the class of fault
 * this module exists to remove.
 */
describe('half-open 32-bit byte ranges', () => {
  it('accepts a one-byte range at the very top of the address space', () => {
    const result = makeRange(0xffffffff, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.range.endExclusive).toBe(ADDRESS_SPACE_END_EXCLUSIVE);
    expect(lastAddress(result.range)).toBe(0xffffffff);
    expect(rangeLength(result.range)).toBe(1);
  });

  it('rejects two bytes at the top of the address space', () => {
    const result = makeRange(0xffffffff, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection).toBe('RANGE_OVERFLOWS_ADDRESS_SPACE');
  });

  it('accepts an exact four-byte fit ending at the top of the space', () => {
    const result = makeRange(0xfffffffc, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.range).toEqual({start: 0xfffffffc, endExclusive: ADDRESS_SPACE_END_EXCLUSIVE});
    expect(lastAddress(result.range)).toBe(0xffffffff);
  });

  it('rejects five bytes from 0xFFFFFFFC', () => {
    const result = makeRange(0xfffffffc, 5);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['negative start', -1, 1, 'START_NEGATIVE'],
    ['fractional start', 1.5, 1, 'START_NOT_SAFE_INTEGER'],
    ['start above the space', ADDRESS_SPACE_END_EXCLUSIVE, 1, 'START_ABOVE_ADDRESS_SPACE'],
    ['zero length', 0x08000000, 0, 'LENGTH_NOT_POSITIVE'],
    ['negative length', 0x08000000, -4, 'LENGTH_NOT_POSITIVE'],
    ['fractional length', 0x08000000, 2.5, 'LENGTH_NOT_SAFE_INTEGER'],
    ['unsafe length', 0x08000000, Number.MAX_SAFE_INTEGER, 'RANGE_OVERFLOWS_ADDRESS_SPACE'],
  ])('rejects %s', (_label, start, length, rejection) => {
    const result = makeRange(start as number, length as number);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection).toBe(rejection);
  });

  it('accepts the smallest possible range', () => {
    const result = makeRange(0, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.range).toEqual({start: 0, endExclusive: 1});
  });

  it('treats containment as half-open: the exclusive end is outside', () => {
    const range = {start: 0x08000000, endExclusive: 0x08000004};
    expect(containsAddress(range, 0x08000000)).toBe(true);
    expect(containsAddress(range, 0x08000003)).toBe(true);
    expect(containsAddress(range, 0x08000004)).toBe(false);
    expect(containsAddress(range, 0x07ffffff)).toBe(false);
  });

  it('treats touching ranges as NOT overlapping', () => {
    const left = {start: 0x08000000, endExclusive: 0x08000100};
    const touching = {start: 0x08000100, endExclusive: 0x08000200};
    const straddling = {start: 0x080000ff, endExclusive: 0x08000200};
    expect(rangesOverlap(left, touching)).toBe(false);
    expect(rangesOverlap(touching, left)).toBe(false);
    expect(rangesOverlap(left, straddling)).toBe(true);
    expect(rangesOverlap(straddling, left)).toBe(true);
  });

  it('contains a range that ends exactly on the outer end', () => {
    const outer = {start: 0x08000000, endExclusive: 0x08020000};
    expect(rangeContainsRange(outer, {start: 0x0801ff00, endExclusive: 0x08020000})).toBe(true);
    expect(rangeContainsRange(outer, {start: 0x0801ff00, endExclusive: 0x08020001})).toBe(false);
    expect(rangeContainsRange(outer, {start: 0x07ffffff, endExclusive: 0x08000004})).toBe(false);
  });
});
