import {IntelHexError, parseIntelHex} from './intelHex';

function record(address: number, type: number, data: readonly number[]): string {
  const bytes = [data.length, address >> 8, address & 0xff, type, ...data];
  const checksum = (-bytes.reduce((sum, byte) => sum + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

describe('parseIntelHex', () => {
  it('parses extended addresses, merges adjacent records, and preserves the entry point', () => {
    const image = parseIntelHex([
      record(0, 4, [0x08, 0x00]),
      record(0, 0, [1, 2]),
      record(2, 0, [3, 4]),
      record(0, 5, [0x08, 0x00, 0x00, 0x01]),
      record(0, 1, []),
    ].join('\n'));
    expect(image.totalBytes).toBe(4);
    expect(image.lowestAddress).toBe(0x08000000);
    expect(image.highestAddressExclusive).toBe(0x08000004);
    expect(image.entryPoint).toBe(0x08000001);
    expect(Array.from(image.segments[0].data)).toEqual([1, 2, 3, 4]);
  });

  it('rejects bad checksums, missing EOF, and overlapping address ranges', () => {
    expect(() => parseIntelHex(':0100000001FF\n:00000001FF')).toThrow(IntelHexError);
    expect(() => parseIntelHex(record(0, 0, [1]))).toThrow(/نهاية/);
    expect(() => parseIntelHex([
      record(0, 4, [0x08, 0x00]),
      record(0, 0, [1, 2]),
      record(1, 0, [3]),
      record(0, 1, []),
    ].join('\n'))).toThrow(/متداخلة/);
  });

  it('rejects data after EOF and unsupported record types', () => {
    expect(() => parseIntelHex(`${record(0, 1, [])}\n${record(0, 0, [1])}`)).toThrow(/بعد سجل/);
    expect(() => parseIntelHex(`${record(0, 6, [1])}\n${record(0, 1, [])}`)).toThrow(/غير مدعوم/);
  });

  it('merges thousands of normal short records into one contiguous region', () => {
    const records = [record(0, 4, [0x08, 0x00])];
    for (let index = 0; index < 4096; index += 1) {
      records.push(record(index * 16, 0, Array.from({length: 16}, (_, byte) => (index + byte) & 0xff)));
    }
    records.push(record(0, 1, []));
    const image = parseIntelHex(records.join('\n'));
    expect(image.totalBytes).toBe(4096 * 16);
    expect(image.segments).toHaveLength(1);
  });
});
