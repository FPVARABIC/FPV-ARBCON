import { crc8DvbS2, crc8DvbS2Step, xorChecksum, xorChecksumStep } from '../mspChecksum';

describe('xorChecksum', () => {
  it('matches a hand-computed XOR for a known byte sequence', () => {
    // 0x01 ^ 0x02 ^ 0x03 ^ 0x04 = 0x04
    expect(xorChecksum(Uint8Array.from([0x01, 0x02, 0x03, 0x04]))).toBe(0x04);
  });

  it('returns the initial value for an empty input', () => {
    expect(xorChecksum(Uint8Array.from([]), 0x42)).toBe(0x42);
  });

  it('xorChecksumStep applied byte-by-byte matches the bulk function', () => {
    const bytes = Uint8Array.from([0x10, 0x20, 0x30, 0xff, 0x00]);
    let stepped = 0;
    for (const b of bytes) stepped = xorChecksumStep(stepped, b);
    expect(stepped).toBe(xorChecksum(bytes));
  });
});

describe('crc8DvbS2', () => {
  // Independent reference vector (NOT derived from this implementation):
  // CRC RevEng catalogue entry "CRC-8/DVB-S2" — width=8 poly=0xD5 init=0x00
  // refin=false refout=false xorout=0x00 check=0xBC, where "check" is the
  // CRC of the ASCII string "123456789".
  // https://reveng.sourceforge.io/crc-catalogue/legend.htm
  it('matches the independently-published CRC-8/DVB-S2 catalogue check value for "123456789"', () => {
    const ascii = Uint8Array.from(Array.from('123456789', (c) => c.charCodeAt(0)));
    expect(crc8DvbS2(ascii)).toBe(0xbc);
  });

  it('returns the initial value for an empty input', () => {
    expect(crc8DvbS2(Uint8Array.from([]), 0x00)).toBe(0x00);
  });

  it('crc8DvbS2Step applied byte-by-byte matches the bulk function', () => {
    const bytes = Uint8Array.from([0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03]);
    let stepped = 0;
    for (const b of bytes) stepped = crc8DvbS2Step(stepped, b);
    expect(stepped).toBe(crc8DvbS2(bytes));
  });

  it('produces different output for different input (basic sanity, not exhaustive)', () => {
    expect(crc8DvbS2(Uint8Array.from([0x00]))).not.toBe(crc8DvbS2(Uint8Array.from([0x01])));
  });
});
