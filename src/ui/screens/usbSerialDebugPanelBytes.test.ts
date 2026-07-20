import {base64ToBytes, bytesToBase64, bytesToHex, parseByteInput} from './usbSerialDebugPanelBytes';

describe('usbSerialDebugPanelBytes', () => {
  it('round-trips arbitrary byte lengths through base64 (0, 1, 2, 3, 5 bytes)', () => {
    const cases = [[], [1], [1, 2], [1, 2, 3], [0, 255, 128, 1, 2]];
    for (const bytes of cases) {
      const original = Uint8Array.from(bytes);
      const roundTripped = base64ToBytes(bytesToBase64(original));
      expect(Array.from(roundTripped)).toEqual(Array.from(original));
    }
  });

  it('formats bytes as lowercase, space-separated hex', () => {
    expect(bytesToHex(Uint8Array.from([0, 1, 0xaa, 0xff]))).toBe('00 01 aa ff');
  });

  it('parses comma/space-separated decimal byte values', () => {
    expect(Array.from(parseByteInput('1,2,3,4,5') ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(parseByteInput('1 2   3') ?? [])).toEqual([1, 2, 3]);
  });

  it('parses 0x-prefixed hex byte values, case-insensitively', () => {
    expect(Array.from(parseByteInput('0xAA,0x55') ?? [])).toEqual([0xaa, 0x55]);
  });

  it('returns null for an out-of-range value instead of clamping or throwing', () => {
    expect(parseByteInput('1,2,256')).toBeNull();
    expect(parseByteInput('1,2,-1')).toBeNull();
  });

  it('returns null for unparseable input instead of throwing', () => {
    expect(parseByteInput('not bytes')).toBeNull();
    expect(parseByteInput('')).toBeNull();
    expect(parseByteInput('   ')).toBeNull();
  });

  it('rejects the whole input on trailing garbage after an otherwise-valid token, not just that token', () => {
    // parseInt('12xyz', 10) === 12 - must not be relied on for validation.
    expect(parseByteInput('1,2,3,4,5x')).toBeNull();
  });

  it('rejects a decimal point instead of silently dropping it', () => {
    // parseInt('3.5', 10) === 3 - must not be relied on for validation.
    expect(parseByteInput('3.5,2')).toBeNull();
  });

  it('rejects an invalid hex digit instead of stopping at it', () => {
    // parseInt('0xAG', 16) === 10 - must not be relied on for validation.
    expect(parseByteInput('0xAG')).toBeNull();
  });

  it('still accepts an uppercase 0X prefix with mixed-case hex digits', () => {
    expect(Array.from(parseByteInput('0X1a') ?? [])).toEqual([0x1a]);
  });
});
